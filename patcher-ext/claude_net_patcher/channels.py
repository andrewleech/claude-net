"""The six existing channel + workflow gate patches, migrated.

Each patch emits Edits with `delta == 0` (same-length surgery). The
regex / replacement strings are lifted verbatim from the v1 patcher.

`expect_count = (1, None)` on every patch here means "apply to every
match, as long as there is at least one" — no upper bound. This
mirrors the anchors' minified-identifier patterns, which can and do
match more than once per build (occurrence counts drift release to
release); every match gets the same same-length rewrite.

Reference: CLAUDE_CODE_PATCHING_GUIDE.md §"Current patches".
"""

import re

from cc_patcher.context import DiscoveryContext
from cc_patcher.edits import Edit


class FeatureGatePatch:
    name = "Feature gate (tengu_harbor)"
    description = "Force the tengu_harbor Statsig feature flag to true."
    may_grow = False
    expect_count = (1, None)
    diag_anchor = b"tengu_harbor"
    PATTERN = rb'\{return [a-zA-Z0-9_$]+\("tengu_harbor",!1\)\}'
    NEW_BODY = b"return!0"

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        edits: list[Edit] = []
        for m in ctx.find_regex_in_payload(self.PATTERN):
            old = m.group(0)
            pad = len(old) - len(self.NEW_BODY) - 2
            new = b"{" + self.NEW_BODY + b" " * pad + b"}"
            edits.append(Edit(
                offset=m.start(), old=old, new=new,
                patch_name=self.name,
            ))
        return edits

    def cache_key(self) -> str:
        return (
            f"FeatureGatePatch:{self.PATTERN.decode('latin1')}:"
            f"{self.NEW_BODY.decode('latin1')}"
        )


class OrgPolicyChannelsEnabledPatch:
    name = "Org policy (channelsEnabled)"
    description = "Invert the channelsEnabled policy check from !==!0 to ===!0."
    may_grow = False
    expect_count = (1, None)
    diag_anchor = b"channelsEnabled"
    OLD = b"channelsEnabled!==!0"
    NEW = b"channelsEnabled===!0"

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        return [
            Edit(
                offset=off, old=self.OLD, new=self.NEW,
                patch_name=self.name,
            )
            for off in ctx.find_in_payload(self.OLD)
        ]

    def cache_key(self) -> str:
        return (
            f"OrgPolicyChannelsEnabledPatch:{self.OLD.decode('latin1')}:"
            f"{self.NEW.decode('latin1')}"
        )


class AllowlistBypassPatch:
    name = "Channel allowlist bypass"
    description = "Replace !VAR.dev with always-false in the allowlist check."
    may_grow = False
    expect_count = (1, None)
    diag_anchor = b'kind:"allowlist"'
    PATTERN = rb'if\(![a-zA-Z0-9_$]+\.dev\)return\{action:"skip",kind:"allowlist"'
    INNER = re.compile(rb"!\w+\.dev")
    NEW_BODY = b"!1"

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        edits: list[Edit] = []
        for m in ctx.find_regex_in_payload(self.PATTERN):
            inner = self.INNER.search(m.group(0))
            if inner is None:
                continue
            inner_start = m.start() + inner.start()
            old = inner.group(0)
            new = self.NEW_BODY + b" " * (len(old) - len(self.NEW_BODY))
            edits.append(Edit(
                offset=inner_start, old=old, new=new,
                patch_name=self.name,
            ))
        return edits

    def cache_key(self) -> str:
        return (
            f"AllowlistBypassPatch:{self.PATTERN.decode('latin1')}:"
            f"{self.NEW_BODY.decode('latin1')}"
        )


class DevChannelsDialogPatch:
    name = "Dev channels dialog auto-accept"
    description = (
        "Force the dev-channels approval dialog's IF branch to fire by "
        "replacing the leading !FOO() with !0 (true) padded to length."
    )
    may_grow = False
    expect_count = (1, None)
    diag_anchor = b'policySettings'
    PATTERN = (
        rb'if\(!\w+\(\)\|\|\w+\(\)!=="firstParty"'
        rb'\|\|\w+\(\w+\("policySettings"\)\)\)'
    )
    INNER = re.compile(rb"!\w+\(\)")
    NEW_BODY = b"!0"

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        edits: list[Edit] = []
        for m in ctx.find_regex_in_payload(self.PATTERN):
            inner = self.INNER.search(m.group(0))
            if inner is None:
                continue
            inner_start = m.start() + inner.start()
            old = inner.group(0)
            new = self.NEW_BODY + b" " * (len(old) - len(self.NEW_BODY))
            edits.append(Edit(
                offset=inner_start, old=old, new=new,
                patch_name=self.name,
            ))
        return edits

    def cache_key(self) -> str:
        return (
            f"DevChannelsDialogPatch:{self.PATTERN.decode('latin1')}:"
            f"{self.NEW_BODY.decode('latin1')}"
        )


class NotificationSuppressionPatch:
    name = "Channel notification suppression"
    description = (
        "Suppress the 'server: entries need --dangerously-load-development-"
        "channels' toast by neutering the !VAR.dev predicate."
    )
    may_grow = False
    expect_count = (1, None)
    diag_anchor = b'server: entries need'
    PATTERN = (
        rb'if\(![a-zA-Z0-9_$]+\.dev\)[a-zA-Z0-9_$]+\.push'
        rb'\(\{entry:[a-zA-Z0-9_$]+,why:"server: entries need'
    )
    INNER = re.compile(rb"!\w+\.dev")
    NEW_BODY = b"!1"

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        edits: list[Edit] = []
        for m in ctx.find_regex_in_payload(self.PATTERN):
            inner = self.INNER.search(m.group(0))
            if inner is None:
                continue
            inner_start = m.start() + inner.start()
            old = inner.group(0)
            new = self.NEW_BODY + b" " * (len(old) - len(self.NEW_BODY))
            edits.append(Edit(
                offset=inner_start, old=old, new=new,
                patch_name=self.name,
            ))
        return edits

    def cache_key(self) -> str:
        return (
            f"NotificationSuppressionPatch:{self.PATTERN.decode('latin1')}:"
            f"{self.NEW_BODY.decode('latin1')}"
        )


class DynamicWorkflowsMasterGatePatch:
    name = "Dynamic workflows master gate (Y2)"
    description = (
        "Force the four-gate Workflow master to return true unconditionally."
    )
    may_grow = False
    expect_count = (1, None)
    diag_anchor = b"available:"
    PATTERN = (
        rb'if\([\w$]+\(\)\)return!1;if\(![\w$]+\(\)\)return!1;'
        rb'let\{available:[\w$]+,defaultOn:[\w$]+\}=[\w$]+\(\);'
        rb'if\(![\w$]+\)return!1;return [\w$]+\(\)\?\?[\w$]+'
    )
    NEW_BODY = b"return!0"

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        edits: list[Edit] = []
        for m in ctx.find_regex_in_payload(self.PATTERN):
            old = m.group(0)
            new = self.NEW_BODY + b" " * (len(old) - len(self.NEW_BODY))
            edits.append(Edit(
                offset=m.start(), old=old, new=new,
                patch_name=self.name,
            ))
        return edits

    def cache_key(self) -> str:
        return (
            f"DynamicWorkflowsMasterGatePatch:{self.PATTERN.decode('latin1')}:"
            f"{self.NEW_BODY.decode('latin1')}"
        )
