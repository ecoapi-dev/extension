"""Negative case: three calls in three different functions are not groupable."""
import anthropic

_client = anthropic.Anthropic()

def summarize(text: str) -> str:
    return _client.messages.create(
        model="claude-3-haiku-20240307",
        max_tokens=512,
        messages=[{"role": "user", "content": f"Summarize: {text}"}],
    ).content[0].text

def translate(text: str, lang: str) -> str:
    return _client.messages.create(
        model="claude-3-haiku-20240307",
        max_tokens=512,
        messages=[{"role": "user", "content": f"Translate to {lang}: {text}"}],
    ).content[0].text

def explain(text: str) -> str:
    return _client.messages.create(
        model="claude-3-haiku-20240307",
        max_tokens=512,
        messages=[{"role": "user", "content": f"Explain: {text}"}],
    ).content[0].text
