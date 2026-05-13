# _smoke fixture

Hand-crafted minimal fixture for runner unit tests. Not vendored from any upstream.

**Scope:** 2 OpenAI calls (chat completion + embeddings in a loop) + 1 expected `batch` finding (embeddings in a `for` loop should be a single batch request).

**Why this fixture exists:** The benchmark runner needs something to iterate against during development without cloning `extension-benchmark`. This fixture is deliberately small and stable.
