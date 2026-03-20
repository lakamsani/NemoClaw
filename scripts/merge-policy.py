#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Merge a base sandbox policy with one or more preset YAML files.
# Usage: merge-policy.py base.yaml [preset1.yaml preset2.yaml ...] > merged.yaml

import sys
import yaml

def main():
    if len(sys.argv) < 2:
        print("Usage: merge-policy.py base.yaml [preset1.yaml ...]", file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1]) as f:
        base = yaml.safe_load(f)

    for preset_path in sys.argv[2:]:
        with open(preset_path) as f:
            preset = yaml.safe_load(f)
        for name, policy in (preset.get("network_policies") or {}).items():
            base.setdefault("network_policies", {})[name] = policy

    yaml.dump(base, sys.stdout, default_flow_style=False, sort_keys=False)

if __name__ == "__main__":
    main()
