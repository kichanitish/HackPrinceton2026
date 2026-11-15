"""Which chat model the agent uses. Claude when an Anthropic key is set, otherwise OpenAI; None means no LLM
(the app then runs its deterministic pipeline). Keys come from .env and are never logged."""
from __future__ import annotations

import os
from typing import Any

ANTHROPIC_DEFAULT = "claude-opus-5-5"
OPENAI_DEFAULT = "gpt-5.5"


def _anthropic_key() -> str | None:
    for name in ("ANTHROPIC_API_KEY", "LLM_API_KEY"):
        key = os.environ.get(name, "")
        if key.startswith("sk-ant-"):
            return key
    return None


def _openai_key() -> str | None:
    key = os.environ.get("OPENAI_API_KEY", "")
    return key if key.startswith("sk-") and not key.startswith("sk-ant-") else None


def model_spec() -> dict[str, str] | None:
    """{"provider", "model"} for the configured model, or None when no key is set."""
    if os.environ.get("AGENT_DISABLED") == "1":
        return None
    if _anthropic_key():
        return {"provider": "anthropic", "model": os.environ.get("AGENT_MODEL_ANTHROPIC", ANTHROPIC_DEFAULT)}
    if _openai_key():
        return {"provider": "openai", "model": os.environ.get("AGENT_MODEL_OPENAI", OPENAI_DEFAULT)}
    return None


def build_chat_model(timeout: float = 60.0) -> Any:
    """A LangChain chat model for the agent. Raises RuntimeError when no key is configured."""
    spec = model_spec()
    if spec is None:
        raise RuntimeError("No LLM key configured (ANTHROPIC_API_KEY or OPENAI_API_KEY).")
    if spec["provider"] == "anthropic":
        from langchain_anthropic import ChatAnthropic
        # Thinking is always on for this model; no sampling parameters are sent.
        return ChatAnthropic(model=spec["model"], api_key=_anthropic_key(), max_tokens=8000,
                             timeout=timeout, max_retries=1)
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(model=spec["model"], api_key=_openai_key(), reasoning={"effort": "low"},
                      use_responses_api=True, timeout=timeout, max_retries=1)
