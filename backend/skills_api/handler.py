"""Read-only skills-catalog BFF Lambda.

Serves the SKILL.md classification-type catalog to the config UI. The source of truth is the
SKILL.md files bundled with the agent; the agent build publishes them as JSON to S3. There is
no CRUD and no DynamoDB — classification types are not stored in DynamoDB.
"""

import json
import os

import boto3


def handle(event, _context):
    """Serve the published skills-catalog JSON on GET /skills."""
    if event.get("routeKey") != "GET /skills":
        return {"statusCode": 404, "body": json.dumps({"error": "no route"})}
    obj = boto3.client("s3").get_object(
        Bucket=os.environ.get("ASSETS_BUCKET", "recon-assets"),
        Key=os.environ.get("SKILLS_CATALOG_KEY", "skills-catalog.json"),
    )
    return {"statusCode": 200, "body": obj["Body"].read().decode()}
