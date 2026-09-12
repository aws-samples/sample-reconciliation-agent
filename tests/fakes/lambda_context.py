"""A stand-in for the Lambda context object: only ``get_remaining_time_in_millis`` is ever read."""


class FakeLambdaContext:
    """Minimal Lambda context; the handlers read nothing but the remaining-time budget."""

    def __init__(self, remaining_ms: int) -> None:
        """:param remaining_ms: milliseconds left in the invocation."""
        self._remaining_ms = remaining_ms

    def get_remaining_time_in_millis(self) -> int:
        """:returns: the remaining budget in milliseconds."""
        return self._remaining_ms


def fake_context(remaining_ms: int = 900_000) -> FakeLambdaContext:
    """A context with ``remaining_ms`` left; the default is Lambda's 15-minute ceiling."""
    return FakeLambdaContext(remaining_ms)
