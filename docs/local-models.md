# Local models

ledgerchat talks to a local model through an OpenAI-compatible chat
completions endpoint. Any server that speaks that protocol and supports tool
calling should work; two are described here. The server must run on the same
machine as ledgerchat: endpoints on `localhost`, `127.0.0.1` or `[::1]` are
accepted and anything else is refused. ledgerchat sends requests only to that
loopback endpoint; the model server controls any onward processing. The chat
loop relies on the model choosing and calling tools, so pick a model that was
trained for it:
the Qwen 3 family is known to work, and a 27B to 32B model at 4-bit is
comfortable on a machine with 32 GB of memory.

## Two ways to configure

**Settings page.** Open **Settings** in the sidebar, enter the server URL,
press **Refresh models** to list what the server serves, choose one, and save.
The choice is written to `model-settings.json` beside the database with
owner-only permissions and applies to chat and categorisation straight away.
A saved key, if your server needs one, is never returned to the browser.

**`.env`.** The CLI commands (`pnpm seed`, `pnpm categorise`, `pnpm chat`)
read the environment, and the web app starts from it until something is saved
in Settings:

```sh
LOCAL_LLM_BASE_URL=http://localhost:8000
LOCAL_LLM_MODEL=<model id exactly as the server lists it>
LOCAL_LLM_API_KEY=local              # sent as a bearer token; most local servers ignore it
LOCAL_LLM_THINKING=false
LOCAL_LLM_PROBE=false
LLM_MAX_TOKENS=8192
```

The model id is case-sensitive and must match what `GET /v1/models` returns;
the chat selector marks the model unreachable when it is not in that list. A
backend spec on the command line is `local/<model id>`.

## Thinking

`LOCAL_LLM_THINKING=false` (the default, and the Settings checkbox) sends
`chat_template_kwargs: {enable_thinking: false}` so a hybrid reasoning model
answers directly. With thinking on, Qwen 3 can spend the whole 8192-token
budget reasoning and return nothing; if you turn it on, raise
`LLM_MAX_TOKENS` to match.

## Structured output

The categoriser asks for a `submit` tool call and parses its arguments (forced
tool choice) rather than requesting a native JSON schema response, because
native structured output was unreliable on the local servers this was set up
against. `LOCAL_LLM_PROBE=true` makes ledgerchat test the endpoint once per
process for streaming, native structured output and forced tool choice, and
use what it finds instead of the conservative defaults.

## oMLX (macOS, Apple silicon)

[oMLX](https://github.com/jundot/omlx) serves MLX models behind an
OpenAI-compatible API on port 8000:

```sh
LOCAL_LLM_BASE_URL=http://localhost:8000
LOCAL_LLM_MODEL=Qwen3.8-27B-4bit
LOCAL_LLM_THINKING=false
```

## Ollama (macOS, Linux, Windows)

Ollama exposes the same protocol on port 11434. Pull a model that supports
tool calling and point ledgerchat at it:

```sh
ollama pull qwen3:32b            # or a size that fits your memory
LOCAL_LLM_BASE_URL=http://localhost:11434
LOCAL_LLM_MODEL=qwen3:32b        # the tag as `ollama list` prints it
LOCAL_LLM_THINKING=false
```

Ollama accepts `chat_template_kwargs` for `enable_thinking` on Qwen 3 models
through its OpenAI-compatible endpoint; if your version does not, thinking
stays on and you should raise `LLM_MAX_TOKENS`. Ollama loads a model on the
first request, so the first question after a restart is slow.

Tool-calling behaviour differs between servers for the same weights: a
different chat template renders the tool definitions differently, and each
server's quantisations are its own. If answers go wrong, try the other server
or a larger model before changing anything else.
