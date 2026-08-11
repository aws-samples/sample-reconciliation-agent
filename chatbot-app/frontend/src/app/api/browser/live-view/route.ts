import { NextRequest, NextResponse } from 'next/server';
import { BedrockAgentCoreClient, GetBrowserSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

// Environment-configurable constants with fallback defaults
// Following Python SDK pattern for consistency
const region = process.env.AWS_REGION || 'us-west-2';
const dpEndpointOverride = process.env.BEDROCK_AGENTCORE_DP_ENDPOINT;
const cpEndpointOverride = process.env.BEDROCK_AGENTCORE_CP_ENDPOINT;

/**
 * Get data plane endpoint (for browser sessions, live view streams)
 * Matches Python SDK: get_data_plane_endpoint()
 */
function getDataPlaneEndpoint(regionName: string = region): string {
  return dpEndpointOverride || `https://bedrock-agentcore.${regionName}.amazonaws.com`;
}

/**
 * Get control plane endpoint (for browser management operations)
 * Matches Python SDK: get_control_plane_endpoint()
 */
function getControlPlaneEndpoint(regionName: string = region): string {
  return cpEndpointOverride || `https://bedrock-agentcore-control.${regionName}.amazonaws.com`;
}

/**
 * Generate presigned Live View URL for browser session
 * GET /api/browser/live-view?sessionId={sessionId}&browserId={browserId}
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    let browserId = searchParams.get('browserId');

    // Fallback to environment variable if browserId not provided
    if (!browserId) {
      browserId = process.env.BROWSER_ID || null;
    }

    if (!sessionId || !browserId) {
      return NextResponse.json(
        { error: 'Missing sessionId or browserId parameter' },
        { status: 400 }
      );
    }

    // Verify session exists and is active
    // Use environment variable endpoint override if provided
    const clientConfig: any = { region };
    if (dpEndpointOverride) {
      clientConfig.endpoint = dpEndpointOverride;
    }
    const client = new BedrockAgentCoreClient(clientConfig);
    const sessionCommand = new GetBrowserSessionCommand({
      browserIdentifier: browserId,
      sessionId: sessionId,
    });

    const sessionResponse = await client.send(sessionCommand);

    if (sessionResponse.status !== 'READY') {
      return NextResponse.json(
        { error: 'Browser session is not active', status: sessionResponse.status },
        { status: 400 }
      );
    }

    // Get the live view stream endpoint from the response
    // Access the live view stream directly (streams is an object, not array)
    const liveViewStream = sessionResponse.streams?.liveViewStream;

    if (!liveViewStream || !liveViewStream.streamEndpoint) {
      return NextResponse.json(
        {
          error: 'Live view stream not available',
          streams: sessionResponse.streams
        },
        { status: 400 }
      );
    }

    const streamEndpoint = liveViewStream.streamEndpoint;

    // Parse the stream endpoint URL
    const endpointUrl = new URL(streamEndpoint);

    const credentials = fromNodeProviderChain();
    const signer = new SignatureV4({
      service: 'bedrock-agentcore',
      region: region,
      credentials: await credentials(),
      sha256: Sha256,
    });

    const expiresIn = 300; // 5 minutes

    // Sign the base live-view endpoint
    // DCV SDK will use the same signature for both /live-view and /live-view/auth
    // by passing query params via httpExtraSearchParams callback
    const presignedRequest = await signer.presign({
      method: 'GET',
      protocol: 'https:',  // Sign as HTTPS, will convert to WSS later
      hostname: endpointUrl.hostname,
      path: endpointUrl.pathname,
      headers: {
        host: endpointUrl.hostname,
      },
    }, {
      expiresIn,
    });

    // Construct full WebSocket URL with properly formatted query parameters
    let queryString = '';
    if (presignedRequest.query) {
      // Convert query object to URLSearchParams string
      if (typeof presignedRequest.query === 'string') {
        queryString = presignedRequest.query;
      } else if (presignedRequest.query instanceof URLSearchParams) {
        queryString = presignedRequest.query.toString();
      } else {
        // It's an object, convert to query string
        queryString = new URLSearchParams(presignedRequest.query as any).toString();
      }
    }

    // Keep HTTPS format (DCV SDK will handle WebSocket conversion internally)
    // DCV will append /auth when authenticating, AWS accepts same signature for both paths
    const basePresignedUrl = `https://${presignedRequest.hostname}${endpointUrl.pathname}${queryString ? '?' + queryString : ''}`;

    return NextResponse.json({
      success: true,
      presignedUrl: basePresignedUrl,
      sessionId: sessionId,
      browserId: browserId,
      expiresIn: expiresIn,
      status: sessionResponse.status,
    });

  } catch (error: any) {
    console.error('Failed to generate live view URL:', error);
    return NextResponse.json(
      {
        error: 'Failed to generate live view URL',
        details: error.message
      },
      { status: 500 }
    );
  }
}
