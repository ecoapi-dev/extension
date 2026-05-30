"""Negative case: different methodChains across functions are not batchable together.

Under Wave 4 semantics the FP guard is exact-methodChain equality: calls to different
methods on the same provider land in separate buckets and never merge into one batch
finding even if there are ≥2 distinct functions.
"""
import anthropic

_client = anthropic.Anthropic()


def summarize(text: str) -> str:
    return _client.messages.create(
        model="claude-3-haiku-20240307",
        max_tokens=512,
        messages=[{"role": "user", "content": f"Summarize: {text}"}],
    ).content[0].text


def count_tokens(text: str) -> int:
    result = _client.messages.count_tokens(
        model="claude-3-haiku-20240307",
        messages=[{"role": "user", "content": text}],
    )
    return result.input_tokens


def explain(text: str) -> str:
    result = _client.beta.messages.create(
        model="claude-3-haiku-20240307",
        max_tokens=512,
        messages=[{"role": "user", "content": f"Explain: {text}"}],
    ).content[0].text
    return result
