import requests

def fetch_completion():
    return requests.post(
        "https://api.openai.com/v1/chat/completions",
        json={"model": "gpt-4o", "messages": []},
    )

fetch_completion()
