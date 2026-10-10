"""Close confirmation for the shared Illustrator export slot.

A result JSON is not evidence that the document closed. Callers keep the
in-flight fence until this function returns a record for the same attempt.
D reuses this function for a later request_kind; it must not grow a second host.
"""

from __future__ import annotations

from typing import Any


EXPORT_PROTOCOL = "beian.illustrator.export/2"
UNFOLDED_REQUEST_KIND = "unfolded_print"
SUPPORTED_REQUEST_KINDS = frozenset({"structure", UNFOLDED_REQUEST_KIND, "native_text"})


def validate_request_kind(config: dict[str, Any]) -> str | None:
    kind = str(config.get("request_kind") or "structure")
    if kind not in SUPPORTED_REQUEST_KINDS:
        return "request_kind_unsupported"
    if kind not in {UNFOLDED_REQUEST_KIND, "native_text"}:
        return None
    if str(config.get("protocol") or "") != EXPORT_PROTOCOL:
        return "protocol_mismatch"
    attempt = str(config.get("attempt_id") or "")
    source_hash = str(config.get("source_sha256") or "")
    if len(attempt) != 32 or len(source_hash) != 64:
        return "attempt_invalid"
    for key in ("source_ai", "print_pdf", "result_json", "close_json"):
        if not str(config.get(key) or "").strip():
            return "export_failed"
    return None


def confirm_export_close(result: dict[str, Any] | None, returncode: int, observation: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Return a close record only after the bridge has exited without a close error.

    The JSX must not set close_confirmed itself. A true value here means the
    result is claiming the document already closed, which is not evidence.
    """

    if returncode != 0 or not isinstance(result, dict):
        return None
    if str(result.get("protocol") or "") != EXPORT_PROTOCOL:
        return None
    if result.get("request_kind") not in {UNFOLDED_REQUEST_KIND, "native_text"}:
        return None
    if result.get("close_confirmed") is True:
        return None
    if any(result.get(key) for key in ("close_error", "close_prep_error", "host_restore_error")):
        return None
    attempt = str(result.get("attempt_id") or "")
    # This observation comes from a post-bridge host probe, never from JSX's
    # result file. In particular, mere file existence cannot release the slot.
    if not isinstance(observation, dict):
        return None
    if (observation.get("attempt_id") != attempt
            or observation.get("bridge_exited") is not True
            or observation.get("document_count") != 0
            or observation.get("documents") != []
            or observation.get("source_sha256") != result.get("source_sha256")
            or len(str(result.get("source_sha256") or "")) != 64):
        return None
    if len(attempt) != 32:
        return None
    return {
        "protocol": EXPORT_PROTOCOL,
        "request_kind": result["request_kind"],
        "attempt_id": attempt,
        "source_sha256": result["source_sha256"],
        "document_closed": True,
        "bridge_exited": True,
        "inflight": False,
        "lock_returnable": True,
    }
