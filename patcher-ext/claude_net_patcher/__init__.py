"""claude-net's channel + workflow-gate patches for the Claude Code binary.

Registers under the `cc_patcher.patches` entry-point group so `cc-patcher`
discovers these patches when this package is installed alongside the
`cc-patcher` engine.
"""

from .channels import (
    AllowlistBypassPatch,
    DevChannelsDialogPatch,
    DynamicWorkflowsMasterGatePatch,
    FeatureGatePatch,
    NotificationSuppressionPatch,
    OrgPolicyChannelsEnabledPatch,
)

PATCHES = [
    FeatureGatePatch(),
    OrgPolicyChannelsEnabledPatch(),
    AllowlistBypassPatch(),
    DevChannelsDialogPatch(),
    NotificationSuppressionPatch(),
    DynamicWorkflowsMasterGatePatch(),
]

__all__ = ["PATCHES"]
