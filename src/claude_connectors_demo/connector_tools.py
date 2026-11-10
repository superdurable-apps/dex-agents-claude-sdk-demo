"""Turn Dex Connectors Library operations into Claude Agent SDK custom tools.

Each connector package ships ``dex-connector.json``. Every factory in it names
an operation (``kind``, ``operationId``, ``inputType``, ``description``,
``branches``, ``inputSchema``, and optionally an ``agent`` review). This module
reads that manifest and builds one ``claude_agent_sdk.tool`` per enabled
operation, plus the ``ToolPolicy`` that tells the Dex agent session where the
call runs:

* A Query is ``READ``. It runs inside the turn through ``run_query``.
* A Mutation is ``IDEMPOTENT_WRITE`` and requires approval. It runs in its own
  session tool Step through ``run_mutation``. Its connector ``CallID`` is
  derived from the session's idempotency key, so every Dex retry of the Step
  reuses the same connector idempotency key.

Results map to what the model reads:

* The happy-path branch returns the operation output as JSON.
* A branch the manifest classifies as ``rejected`` (the call changed nothing),
  and any other Query branch, returns an error result with the connector's
  safe failure message.
* A Mutation branch classified ``unknown``, or unclassified, returns an error
  result that says plainly that the outcome is unknown and must not be blindly
  retried.
* A connector ``RetryError`` in a tool Step propagates, so Dex retries the Step
  with the same ``CallID``. An inline read cannot fail its Step, so it retries
  in place a few times and then reports a temporary failure.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import timedelta
from importlib import resources
from typing import Any, Literal, cast
from uuid import UUID, uuid4, uuid5

from claude_agent_sdk import SdkMcpTool, ToolAnnotations, tool
from dex import CodecRegistry, Value, WireKind
from dex_agents import DeferredToolExecution, ToolEffect, ToolPolicy
from dex_agents_claude_agent_sdk import current_deferred_tool_execution
from dex_connectors.sdk import (
    Call,
    CallID,
    MutationResult,
    QueryResult,
    RetryError,
    run_mutation,
    run_query,
)

from claude_connectors_demo.connector_context import (
    deferred_tool_call_context,
    inline_tool_call_context,
)

LOGGER = logging.getLogger(__name__)

MANIFEST_FILE_NAME = "dex-connector.json"
# Namespace of connector Call IDs derived from agent session idempotency keys.
AGENT_TOOL_CALL_ID_NAMESPACE = UUID("6f1d3c2e-5b7a-4e1f-9a3c-8d2b0e4f7a61")
MAX_TOOL_OUTPUT_CHARACTERS = 16_000
INLINE_READ_ATTEMPTS = 3
INLINE_READ_MAX_RETRY_DELAY = timedelta(seconds=5)

OperationKind = Literal["query", "mutation"]
BranchOutcome = Literal["succeeded", "rejected", "unknown"]


@dataclass(frozen=True)
class OperationAgentReview:
    """The connector author's review of an operation for agent use (manifest ``agent``)."""

    is_exposed: bool
    is_approval_recommended: bool
    description: str
    branch_classes: Mapping[str, str]


@dataclass(frozen=True)
class ConnectorOperationManifest:
    """One operation factory of ``dex-connector.json``."""

    kind: OperationKind
    operation_id: str
    input_type_name: str
    description: str
    input_schema: Mapping[str, Any]
    happy_branch_id: str
    optional_branch_ids: tuple[str, ...]
    agent_review: OperationAgentReview | None

    def classify_branch(self, branch_id: str) -> BranchOutcome:
        """Classify a returned branch by whether the operation's effect may have happened."""
        if branch_id == self.happy_branch_id:
            return "succeeded"
        reviewed_class = (
            None if self.agent_review is None else self.agent_review.branch_classes.get(branch_id)
        )
        if reviewed_class == "rejected" or self.kind == "query":
            return "rejected"
        # The manifest schema: a host treats an unlisted optional Mutation branch as unknown.
        return "unknown"


@dataclass(frozen=True)
class ConnectorManifest:
    """The operations a connector package declares."""

    connector_id: str
    operations: Mapping[str, ConnectorOperationManifest]


@dataclass(frozen=True)
class ConnectorBinding:
    """One connector connection and the operations to offer the agent as tools.

    Attributes:
        tool_prefix: Prefix of every tool name, such as ``"slack"`` for
            ``slack_post_thread_reply``.
        package: The connector's Python package, such as ``"dex_connectors.slack"``.
            It holds ``dex-connector.json`` and the operation input types.
        connection: The connector's ``Connection``, real or a mock.
        enabled_operation_ids: Manifest ``operationId`` values to offer, in order.
    """

    tool_prefix: str
    package: str
    connection: object
    enabled_operation_ids: Sequence[str]


@dataclass
class ConnectorToolset:
    """Custom tools and their session policies, ready for ``claude_agent_session_flow``."""

    tools: list[SdkMcpTool[Any]] = field(default_factory=list)
    policies: dict[str, ToolPolicy] = field(default_factory=dict)


def build_connector_toolset(bindings: Sequence[ConnectorBinding]) -> ConnectorToolset:
    """Build one tool and one policy per enabled operation of every binding.

    Raises:
        ValueError: If an enabled operation is missing from the manifest or
            the connection, or two tools would share a name.
    """
    toolset = ConnectorToolset()
    for binding in bindings:
        manifest = load_connector_manifest(binding.package)
        package_module = importlib.import_module(binding.package)
        for operation_id in binding.enabled_operation_ids:
            operation_manifest = manifest.operations.get(operation_id)
            if operation_manifest is None:
                raise ValueError(f"{binding.package} declares no operation {operation_id!r}")
            connector_tool = ConnectorOperationTool(
                tool_name=f"{binding.tool_prefix}_{snake_case(operation_id)}",
                manifest=operation_manifest,
                operation=_bound_operation(binding.connection, operation_id),
                connection_reference=binding.connection.reference,
                input_type=_input_type(package_module, operation_manifest.input_type_name),
            )
            if connector_tool.tool_name in toolset.policies:
                raise ValueError(
                    f"two connector operations share the tool name {connector_tool.tool_name}"
                )
            toolset.tools.append(connector_tool.build_sdk_tool())
            toolset.policies[connector_tool.tool_name] = connector_tool.policy()
    return toolset


def load_connector_manifest(package: str) -> ConnectorManifest:
    """Read ``dex-connector.json`` from an installed connector package."""
    document = json.loads(resources.files(package).joinpath(MANIFEST_FILE_NAME).read_text("utf-8"))
    operations: dict[str, ConnectorOperationManifest] = {}
    for factory in document["factories"]:
        kind = factory["kind"]
        if kind not in ("query", "mutation"):
            continue
        branches = factory["branches"]
        required_branch_ids = [branch["id"] for branch in branches if not branch["optional"]]
        if len(required_branch_ids) != 1:
            raise ValueError(f"{factory['operationId']} must have exactly one required branch")
        operations[factory["operationId"]] = ConnectorOperationManifest(
            kind=kind,
            operation_id=factory["operationId"],
            input_type_name=factory["inputType"],
            description=factory["description"],
            input_schema=factory["inputSchema"],
            happy_branch_id=required_branch_ids[0],
            optional_branch_ids=tuple(branch["id"] for branch in branches if branch["optional"]),
            agent_review=_agent_review(factory.get("agent")),
        )
    return ConnectorManifest(document["connectorId"], operations)


def snake_case(operation_id: str) -> str:
    """Return ``list_story_ids`` for ``listStoryIDs``."""
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", operation_id).lower()


def connector_call_id(idempotency_key: str) -> CallID:
    """Derive the connector ``CallID`` of a deferred tool call from its session idempotency key."""
    return CallID(str(uuid5(AGENT_TOOL_CALL_ID_NAMESPACE, idempotency_key)))


class ConnectorOperationTool:
    """One connector operation offered to the agent as a custom tool."""

    def __init__(
        self,
        *,
        tool_name: str,
        manifest: ConnectorOperationManifest,
        operation: Any,
        connection_reference: Any,
        input_type: type,
    ) -> None:
        self.tool_name = tool_name
        self._manifest = manifest
        self._operation = operation
        self._connection_reference = connection_reference
        self._definition = operation.definition()
        self._input_codec = CodecRegistry().resolve(input_type)
        if self._definition.operation.operation_id != manifest.operation_id:
            raise ValueError(f"{tool_name}: the connection serves another operation")

    def build_sdk_tool(self) -> SdkMcpTool[Any]:
        """Return the Claude Agent SDK tool that runs this operation."""
        review = self._manifest.agent_review
        description = (review.description if review and review.description else None) or (
            self._manifest.description
        )
        annotations = ToolAnnotations(readOnlyHint=self._manifest.kind == "query")
        return tool(self.tool_name, description, dict(self._manifest.input_schema), annotations)(
            self.call
        )

    def policy(self) -> ToolPolicy:
        """Return where a call runs: a query inline, a mutation in a Step after approval."""
        if self._manifest.kind == "mutation":
            return ToolPolicy(ToolEffect.IDEMPOTENT_WRITE, requires_approval=True)
        review = self._manifest.agent_review
        if review is not None and review.is_approval_recommended:
            return ToolPolicy(ToolEffect.READ, requires_approval=True)
        return ToolPolicy(ToolEffect.READ)

    async def call(self, arguments: dict[str, Any]) -> dict[str, Any]:
        """Run the operation once for the model's arguments and describe the result."""
        try:
            operation_input = self._input_codec.decode(Value(WireKind.JSON, json.dumps(arguments)))
        except (TypeError, ValueError) as error:
            return _text_result(f"Invalid arguments for {self.tool_name}: {error}", is_error=True)
        execution = current_deferred_tool_execution()
        if self._manifest.kind == "mutation":
            if execution is None:
                raise RuntimeError(f"{self.tool_name} must run in its own tool Step")
            return await self._run_mutation(operation_input, execution)
        if execution is None:
            return await self._run_inline_query(operation_input)
        return self._describe_result(
            await run_query(self._operation, self._deferred_call(execution), operation_input)
        )

    async def _run_mutation(
        self, operation_input: object, execution: DeferredToolExecution
    ) -> dict[str, Any]:
        call = self._deferred_call(execution)
        LOGGER.info(
            "connector mutation %s attempt %d call %s", self.tool_name, execution.attempt, call.id
        )
        # A RetryError propagates: the session retries the Step, and the Call ID stays the same.
        result = await run_mutation(self._operation, call, operation_input)
        return self._describe_result(result)

    async def _run_inline_query(self, operation_input: object) -> dict[str, Any]:
        last_error: RetryError | None = None
        for attempt in range(1, INLINE_READ_ATTEMPTS + 1):
            call = Call(
                CallID(str(uuid4())),
                self._connection_reference,
                self._definition.operation,
                context=inline_tool_call_context(
                    self._definition.step_defaults.execute_method_timeout
                ),
            )
            try:
                return self._describe_result(
                    await run_query(self._operation, call, operation_input)
                )
            except RetryError as error:
                last_error = error
                LOGGER.info(
                    "connector query %s retryable failure on attempt %d", self.tool_name, attempt
                )
                if attempt < INLINE_READ_ATTEMPTS:
                    delay = min(
                        max(error.retry_after_seconds, float(attempt)),
                        INLINE_READ_MAX_RETRY_DELAY.total_seconds(),
                    )
                    await asyncio.sleep(delay)
        failure = cast(RetryError, last_error).failure
        return _text_result(
            f"{self.tool_name} is temporarily unavailable after {INLINE_READ_ATTEMPTS} attempts "
            f"({failure.kind}): {failure.message}. Nothing was changed; you may try again later.",
            is_error=True,
        )

    def _deferred_call(self, execution: DeferredToolExecution) -> Call:
        return Call(
            connector_call_id(execution.idempotency_key),
            self._connection_reference,
            self._definition.operation,
            context=deferred_tool_call_context(
                execution, self._definition.step_defaults.execute_method_timeout
            ),
        )

    def _describe_result(self, result: QueryResult[Any] | MutationResult[Any]) -> dict[str, Any]:
        outcome = self._manifest.classify_branch(result.branch)
        LOGGER.info("connector %s returned branch %s (%s)", self.tool_name, result.branch, outcome)
        if outcome == "succeeded":
            return _text_result(_encode_output(result.branch, result.value), is_error=False)
        failure = result.failure
        detail = (
            f"{failure.kind}: {failure.message}" if failure is not None else "no failure detail"
        )
        if outcome == "rejected":
            changed_nothing = " Nothing was changed." if self._manifest.kind == "mutation" else ""
            return _text_result(
                f"{self.tool_name} returned '{result.branch}' ({detail}).{changed_nothing}",
                is_error=True,
            )
        return _text_result(
            f"The outcome of {self.tool_name} is unknown: the connector returned "
            f"'{result.branch}' ({detail}). The change may or may not have taken effect. "
            f"Do not call {self.tool_name} again for this request. Tell the user what you "
            "tried and ask them to check before trying again.",
            is_error=True,
        )


def _agent_review(document: Mapping[str, Any] | None) -> OperationAgentReview | None:
    if document is None:
        return None
    return OperationAgentReview(
        is_exposed=bool(document["exposed"]),
        is_approval_recommended=document.get("approval") == "recommended",
        description=str(document.get("description") or ""),
        branch_classes=dict(document.get("branches") or {}),
    )


def _bound_operation(connection: object, operation_id: str) -> Any:
    # Most generated connections expose operations as methods; Gmail's exposes attributes.
    member = getattr(connection, snake_case(operation_id), None)
    if member is None:
        raise ValueError(f"{type(connection).__name__} has no operation {operation_id!r}")
    return member if hasattr(member, "definition") else member()


def _input_type(package_module: Any, input_type_name: str) -> type:
    for module in (package_module, importlib.import_module(f"{package_module.__name__}.models")):
        input_type = getattr(module, input_type_name, None)
        if isinstance(input_type, type):
            return input_type
    raise ValueError(f"{package_module.__name__} has no input type {input_type_name}")


def _encode_output(branch_id: str, value: object) -> str:
    encoded_value: object = None
    if value is not None:
        encoded_value = json.loads(
            cast(str, CodecRegistry().resolve(type(value)).encode(value).data)
        )
    text = json.dumps({"branch": branch_id, "value": encoded_value}, ensure_ascii=False)
    if len(text) > MAX_TOOL_OUTPUT_CHARACTERS:
        return text[:MAX_TOOL_OUTPUT_CHARACTERS] + " ...[output truncated]"
    return text


def _text_result(text: str, *, is_error: bool) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "is_error": is_error}
