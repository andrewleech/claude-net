"""The channel + workflow gate patches.

Most patches here emit Edits with `delta == 0` (same-length surgery);
`SessionChannelListPatch` is the one growable exception.

`expect_count = (1, None)` on the same-length patches means "apply to
every match, as long as there is at least one" — no upper bound. This
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


class SessionChannelListPatch:
    """Give the per-session channel lookup a synthetic fallback entry.

    `s2r()` decides whether an MCP server may register a channel. After
    the capability / provider / policy checks it does:

        let i=IRt(e,tR());
        if(!i)return{action:"skip",kind:"session",
                     reason:`server ${e} not in --channels list ...`};

    `tR()` is `allowedChannels()`, populated only from
    `--dangerously-load-development-channels` (a.k.a. `--channels`), so
    without that flag every server is skipped no matter how many of the
    downstream policy / allowlist / dialog gates are neutered. This is
    the one channel gate that cannot be forced from inside the binary
    by a boolean flip — the code needs an *entry object*, not a true.

    So append `??{kind:"server",name:e,dev:!0}` to the lookup: an
    explicitly-listed server or plugin still resolves to its real
    entry (preserving the marketplace check for `kind:"plugin"`), and
    anything unlisted gets a synthetic dev server entry, which reaches
    `{action:"register"}`. Channels then work under any launcher,
    including ones that exec the patched binary with no channel argv.

    Grows the payload by the length of the appended expression, so this
    is a growable edit and must declare its containing StringPointer
    region.

    Anchored on the body signature rather than the minified function
    name (`IRt` in 2.1.229), which drifts every release.
    """

    name = "Session channel list fallback (IRt)"
    description = (
        "Make the per-session channel lookup fall back to a synthetic "
        "server entry so channels register without "
        "--dangerously-load-development-channels."
    )
    may_grow = True
    expect_count = 1
    diag_anchor = b"not in --channels list for this session"
    ANCHOR_RX = (
        rb'function [\w$]{1,6}\(e,t\)\{'
        rb'(?=let r=e\.split\(":"\);return t\.find\(\(n\)=>n\.kind==="server")'
    )
    FALLBACK = b'??{kind:"server",name:e,dev:!0}'

    def discover(self, ctx: DiscoveryContext) -> list[Edit]:
        matches = ctx.find_regex_in_payload(self.ANCHOR_RX)
        if len(matches) != 1:
            return []
        body_start = matches[0].end()
        body_end = ctx.find_balanced_close(
            body_start, ctx.bun.offsets_struct_offset,
        )
        if body_end is None:
            return []
        # The fallback is only valid appended directly to the trailing
        # `t.find(...)` call expression. A different last byte means the
        # body shape drifted (e.g. a trailing `;`), so emit nothing and
        # let the expect_count check report the miss.
        if ctx.buf[body_end - 1] != ord(")"):
            return []
        region = ctx.containing_string_pointer(body_end)
        if region is None:
            return []
        return [Edit(
            offset=body_end, old=b"}", new=self.FALLBACK + b"}",
            patch_name=self.name, grows_region=region,
        )]

    def cache_key(self) -> str:
        return (
            f"SessionChannelListPatch:{self.ANCHOR_RX.decode('latin1')}:"
            f"{self.FALLBACK.decode('latin1')}"
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
        rb'let\{available:[\w$]+,defaultOn:[\w$]+\}=[\w$]+(?:\.[\w$]+)*\(\);'
        rb'if\(![\w$]+\)return!1;return [\w$]+\(\)(?:\?\.[\w$]+(?:\.[\w$]+)*)?\?\?[\w$]+'
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
