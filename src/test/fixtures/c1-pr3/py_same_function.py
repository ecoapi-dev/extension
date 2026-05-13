"""Positive case: three calls in the same function should be awaited concurrently."""
import anthropic

_client = anthropic.Anthropic()

def triple_summarize(a: str, b: str, c: str) -> tuple[str, str, str]:
    ra = _client.messages.create(model="claude-3-haiku-20240307", max_tokens=256, messages=[{"role": "user", "content": a}])
    rb = _client.messages.create(model="claude-3-haiku-20240307", max_tokens=256, messages=[{"role": "user", "content": b}])
    rc = _client.messages.create(model="claude-3-haiku-20240307", max_tokens=256, messages=[{"role": "user", "content": c}])
    return ra.content[0].text, rb.content[0].text, rc.content[0].text
