/**
 * API Client - Centralized fetch wrapper that attaches a Microsoft Entra ID
 * access token to every backend request. The token is acquired via MSAL
 * (the singleton instance EntraAuthWrapper stashes on window).
 */

import { getApiUrl } from "@/config/environment";
import { getAuthHeaders } from "@/lib/access-token";

/**
 * Fetch wrapper with automatic authentication
 * Usage: apiFetch('tools', { method: 'GET' })
 */
export async function apiFetch(
  endpoint: string,
  options: RequestInit = {},
): Promise<Response> {
  // Get auth headers
  const authHeaders = await getAuthHeaders();

  // Merge headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...authHeaders,
    ...((options.headers as Record<string, string>) || {}),
  };

  // Build full URL
  const url = getApiUrl(endpoint);

  // Make request
  const response = await fetch(url, {
    ...options,
    headers,
  });

  return response;
}

/**
 * Fetch JSON with automatic authentication
 * Usage: const data = await apiFetchJson('tools')
 */
export async function apiFetchJson<T = any>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await apiFetch(endpoint, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API request failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * POST JSON with automatic authentication
 * Usage: const data = await apiPost('tools/toggle', { toolId: 'calculator' })
 */
export async function apiPost<T = any>(
  endpoint: string,
  body?: any,
  options: RequestInit = {},
): Promise<T> {
  return apiFetchJson<T>(endpoint, {
    ...options,
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * PUT JSON with automatic authentication
 */
export async function apiPut<T = any>(
  endpoint: string,
  body?: any,
  options: RequestInit = {},
): Promise<T> {
  return apiFetchJson<T>(endpoint, {
    ...options,
    method: "PUT",
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * DELETE with automatic authentication
 */
export async function apiDelete<T = any>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  return apiFetchJson<T>(endpoint, {
    ...options,
    method: "DELETE",
  });
}

/**
 * GET JSON with automatic authentication
 * Usage: const data = await apiGet<Tool[]>('tools')
 */
export async function apiGet<T = any>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  return apiFetchJson<T>(endpoint, {
    ...options,
    method: "GET",
  });
}
