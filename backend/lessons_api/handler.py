"""Read-only BFF for the lessons-learned UI tab. Lists lessons from the recon-lessons ledger."""
import json
import os

from backend.recon_core.lessons import LessonStore


def handle(event, _context):
    """Serve lessons on GET /lessons (optional ?domain= filter)."""
    if event.get("routeKey") not in ("GET /lessons",):
        return {"statusCode": 404, "body": json.dumps({"error": "no route"})}
    domain = (event.get("queryStringParameters") or {}).get("domain")
    store = LessonStore(table=os.environ.get("LESSONS_TABLE", "recon-lessons"))
    return {"statusCode": 200, "body": json.dumps(store.list_recent(domain=domain), default=str)}
