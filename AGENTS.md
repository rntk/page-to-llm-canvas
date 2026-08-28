# Welcome, Agent! 

To ensure optimal performance, keep context clean, and minimize token costs, please adhere to the following rules when working in this codebase.

---
## 1. Run Tests via Subagents (Context Management)

Running test suites (e.g., Jest, Vitest, Cypress, Playwright, etc.) directly in the main agent's terminal can generate extremely verbose test outputs, stack traces, and logs. This pollutes your context window, increases latency, and degrades reasoning quality.

### Guidelines:

- **Always delegate testing to a subagent** when running full test suites or tests that generate long outputs.
- The subagent should execute the tests, analyze the log files/terminal output, and report back only the critical details (e.g., overall pass/fail status and a concise summary of specific failures).
- **Do not** dump full test outputs/logs into the main conversation history.

---

## 2. Use Cheaper and Faster Models for Subagents

When delegating tasks to subagents, optimize for speed and cost. High-reasoning frontier models (like Gemini Pro, Opus/Fable or GPT-5.6 Sol) are not always necessary for routine tasks.

### Guidelines:

- Select faster, lightweight, and cost-effective models for subagents unless complex reasoning, planning, or architecture design is required.
- **Recommended models for routine subagent tasks:**
  - **Gemini:** Gemini Flash models
  - **Claude:** Claude Sonnet / Haiku
  - **OpenAI:** GPT mini, Luna, Terra
