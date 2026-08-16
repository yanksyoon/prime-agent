"""Small JSON bridge for embedded Graphiti memory operations.

The TypeScript host invokes this module in the kernel virtualenv so Graphiti and
its Python dependencies remain isolated from the Node process. Secrets are read
from environment variables named by the request configuration and never placed
in command arguments.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any

from graphiti_core import Graphiti
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.llm_client import LLMConfig, OpenAIClient


def _required(config: dict[str, Any], key: str, label: str) -> str:
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"memory setting {label} is required")
    return value.strip()


def _env(config: dict[str, Any], key: str, default_name: str | None = None) -> str:
    name = config.get(key) or default_name
    if not isinstance(name, str) or not name.strip():
        raise RuntimeError(f"memory setting {key} must name an environment variable")
    value = os.environ.get(name.strip(), "").strip()
    if value:
        return value
    raise RuntimeError(f"environment variable {name.strip()} is not set")


def _secret(config: dict[str, Any], env_key: str, file_key: str, default_name: str | None = None) -> str:
    env_name = config.get(env_key) or default_name
    if isinstance(env_name, str) and env_name.strip():
        value = os.environ.get(env_name.strip(), "").strip()
        if value:
            return value
    file_name = config.get(file_key)
    if isinstance(file_name, str) and file_name.strip():
        try:
            with open(os.path.expanduser(file_name.strip()), encoding="utf-8") as secret_file:
                value = secret_file.read().strip()
            if value:
                return value
        except OSError:
            pass
    display = env_name.strip() if isinstance(env_name, str) and env_name.strip() else file_key
    raise RuntimeError(f"secret is not available from {display} or {file_key}")


def _graphiti(config: dict[str, Any]) -> Graphiti:
    uri = _required(config, "endpoint", "memory.endpoint (Neo4j Bolt URI)")
    user = str(config.get("neo4jUser") or "neo4j")
    password = _secret(config, "neo4jPasswordEnv", "neo4jPasswordFile", "GRAPHITI_NEO4J_PASSWORD")
    llm_api_key = _env(config, "llmApiKeyEnv", "GRAPHITI_LLM_API_KEY")
    llm_model = _required(config, "llmModel", "memory.llmModel")
    llm_base_url = config.get("llmBaseUrl") or None
    embedding_api_key = _env(config, "embeddingApiKeyEnv", config.get("llmApiKeyEnv") or "GRAPHITI_LLM_API_KEY")
    embedding_base_url = config.get("embeddingBaseUrl") or llm_base_url
    embedding_model = str(config.get("embeddingModel") or "text-embedding-3-small")

    llm_client = OpenAIClient(
        LLMConfig(api_key=llm_api_key, model=llm_model, base_url=llm_base_url),
    )
    embedder = OpenAIEmbedder(
        OpenAIEmbedderConfig(
            api_key=embedding_api_key,
            base_url=embedding_base_url,
            embedding_model=embedding_model,
        ),
    )
    return Graphiti(uri=uri, user=user, password=password, llm_client=llm_client, embedder=embedder)


def _workspace(config: dict[str, Any]) -> str:
    return str(config.get("workspace") or "prime-agent")


def _edge_result(edge: Any) -> dict[str, Any]:
    return {
        "id": str(getattr(edge, "uuid", "")),
        "name": str(getattr(edge, "name", "")),
        "fact": str(getattr(edge, "fact", "")),
        "groupId": str(getattr(edge, "group_id", "") or ""),
        "episodes": [str(value) for value in (getattr(edge, "episodes", None) or [])],
    }


def _episode_result(episode: Any) -> dict[str, Any]:
    return {
        "id": str(getattr(episode, "uuid", "")),
        "name": str(getattr(episode, "name", "")),
        "content": str(getattr(episode, "content", "")),
        "groupId": str(getattr(episode, "group_id", "") or ""),
        "referenceTime": getattr(episode, "reference_time", None).isoformat()
        if getattr(episode, "reference_time", None)
        else None,
    }


async def _handle(request: dict[str, Any]) -> dict[str, Any]:
    config = request.get("config")
    if not isinstance(config, dict):
        raise RuntimeError("Graphiti memory configuration is missing")
    graphiti = _graphiti(config)
    try:
        operation = request.get("operation")
        group_id = _workspace(config)
        if operation == "doctor":
            await graphiti.build_indices_and_constraints()
            return {"ok": True, "workspace": group_id}
        if operation == "search":
            query = str(request.get("query") or "").strip()
            if not query:
                episodes = await graphiti.retrieve_episodes(
                    reference_time=datetime.now(timezone.utc), last_n=20, group_ids=[group_id]
                )
                return {"ok": True, "items": [_episode_result(item) for item in episodes]}
            edges = await graphiti.search(query=query, group_ids=[group_id], num_results=10)
            return {"ok": True, "items": [_edge_result(item) for item in edges]}
        if operation == "remember":
            title = _required(request, "title", "memory title")
            content = _required(request, "content", "memory content")
            result = await graphiti.add_episode(
                name=title,
                episode_body=content,
                source_description="Prime Agent explicit memory",
                reference_time=datetime.now(timezone.utc),
                group_id=group_id,
            )
            return {"ok": True, "item": _episode_result(result.episode)}
        if operation == "forget":
            episode_id = _required(request, "id", "memory id")
            await graphiti.remove_episode(episode_id)
            return {"ok": True, "id": episode_id}
        raise RuntimeError(f"unknown Graphiti memory operation: {operation!r}")
    finally:
        await graphiti.close()


def main() -> None:
    raw = sys.stdin.read()
    try:
        request = json.loads(raw)
        result = asyncio.run(_handle(request))
    except Exception as error:  # bridge boundary: return errors as data to the host
        result = {"ok": False, "error": str(error)}
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
