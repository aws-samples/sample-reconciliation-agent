"""A canned ``bedrock-agentcore`` data-plane client for the memory recall paths."""


def _summary(record: str | dict) -> dict:
    if isinstance(record, str):
        return {"content": {"text": record}}
    return {"memoryRecordId": record.get("record_id", ""), "content": {"text": record["text"]}}


class FakeMemoryClient:
    """Answers ``retrieve_memory_records`` from a script and records every request in ``calls``.

    :param records: what to serve as ``memoryRecordSummaries``: lesson texts (``str``, the shape
        recon's lessons recall reads) or ``{record_id, text}`` dicts (the deal pipeline's).
    :param response: the full raw response instead of ``records``, for shapes ``records`` cannot
        express (a summary with no content at all).
    :param error: raised by every call instead of answering.
    """

    def __init__(self, records: list | None = None, *, response: dict | None = None, error=None):
        self.calls: list[dict] = []
        self.error = error
        if response is None:
            response = {"memoryRecordSummaries": [_summary(r) for r in records or []]}
        self.response = response

    def retrieve_memory_records(self, **kwargs) -> dict:
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.response
