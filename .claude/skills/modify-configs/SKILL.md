---
name: modify-configs
description: Load into context when the user asks you to implement or modify jobfinder.config.js configs
---

Remember to update the relevant config file(s) under `examples/` (e.g. `jobfinder-ollama.config.js`, `jobfinder-openrouter.config.js`) when modifying or adding new configuration options. Each config file corresponds to a different LLM plugin and may have unique options, but they share some common ones (e.g. `DATA_DIR`, `DB_NAME`) that should be kept in sync across files if modified.
