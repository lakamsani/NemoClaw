// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import nimImages from "../../../bin/lib/nim-images.json";

export interface GpuInfo {
  type: "nvidia" | "apple";
  count: number;
  totalMemoryMB: number;
  perGpuMB: number;
  nimCapable: boolean;
  family?: string | null;
  families?: string[];
  names?: string[];
  freeDiskGB?: number | null;
  name?: string;
  cores?: number | null;
  spark?: boolean;
}

export interface NimProfile {
  gpuFamilies?: string[];
  minGpuCount?: number;
  minPerGpuMemoryMB?: number;
  minDiskSpaceGB?: number;
  precision?: string;
  diskSource?: string;
}

export interface NimModel {
  name: string;
  image: string;
  minGpuMemoryMB: number;
  servedModel?: string;
  recommendedRank?: number;
  recommendedFor?: string[];
  profiles?: NimProfile[];
}

export interface NimRuntime {
  exec(command: string): string;
}

const MODEL_PULL_ALIASES: Record<string, string[]> = {
  "nvidia/nemotron-3-nano-30b-a3b": ["nvcr.io/nim/nvidia/nemotron-3-nano:latest"],
};
const MODEL_API_ALIASES: Record<string, string> = {
  "nvidia/nemotron-3-nano-30b-a3b": "nvidia/nemotron-3-nano",
};

function normalizeGpuFamily(name: string): string | null {
  const value = name.toLowerCase();
  if (value.includes("gb10") || value.includes("dgx spark")) return "dgx-spark";
  if (value.includes("gb200")) return "gb200";
  if (value.includes("b200")) return "b200";
  if (value.includes("gh200")) return "gh200";
  if (value.includes("h200")) return "h200";
  if (value.includes("h100")) return "h100";
  if (value.includes("h20")) return "h20";
  if (value.includes("l40s")) return "l40s";
  if (value.includes("a10g")) return "a10g";
  if (value.includes("a100")) return "a100";
  if (value.includes("rtx 6000 ada")) return "rtx6000-ada";
  if (value.includes("blackwell server edition")) return "rtx-pro-6000-blackwell";
  if (value.includes("rtx 5090")) return "rtx5090";
  if (value.includes("rtx 4090")) return "rtx4090";
  return null;
}

export function createNimRuntime(): NimRuntime {
  return {
    exec(command: string): string {
      return execSync(command, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], shell: "/bin/bash" });
    },
  };
}

function tryExec(runtime: NimRuntime, command: string): string {
  try {
    return runtime.exec(command).trim();
  } catch {
    return "";
  }
}

function extractExecErrorMessage(err: unknown): string {
  if (!err || typeof err !== "object") {
    return String(err);
  }
  const stderr = "stderr" in err ? String((err as { stderr?: unknown }).stderr ?? "") : "";
  const message = "message" in err ? String((err as { message?: unknown }).message ?? "") : "";
  return `${message}\n${stderr}`.trim();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getPullCandidatesForModel(modelName: string): string[] {
  const primary = getImageForModel(modelName);
  if (!primary) {
    return [];
  }
  return [primary, ...(MODEL_PULL_ALIASES[modelName] ?? [])];
}

export function getServedModelForModel(modelName: string): string {
  return MODEL_API_ALIASES[modelName] ?? modelName;
}

function getContainerCredentialArgs(): string[] {
  const credentials: string[] = [];
  const ngcApiKey = process.env.NGC_API_KEY?.trim();
  const nvidiaApiKey = process.env.NVIDIA_API_KEY?.trim();
  if (nvidiaApiKey) {
    credentials.push(`-e NVIDIA_API_KEY=${shellQuote(nvidiaApiKey)}`);
  }
  const effectiveNgcApiKey = ngcApiKey || nvidiaApiKey;
  if (effectiveNgcApiKey) {
    credentials.push(`-e NGC_API_KEY=${shellQuote(effectiveNgcApiKey)}`);
  }
  return credentials;
}

export function containerName(sandboxName: string): string {
  return `nemoclaw-nim-${sandboxName}`;
}

export function listModels(): NimModel[] {
  return nimImages.models.map((model) => ({
    name: model.name,
    image: model.image,
    minGpuMemoryMB: model.minGpuMemoryMB,
    servedModel: model.servedModel ?? getServedModelForModel(model.name),
    recommendedRank: model.recommendedRank ?? Number.MAX_SAFE_INTEGER,
    recommendedFor: model.recommendedFor ?? [],
    profiles: model.profiles ?? [],
  }));
}

export function getImageForModel(modelName: string): string | null {
  return listModels().find((model) => model.name === modelName)?.image ?? null;
}

export function detectGpu(runtime: NimRuntime): GpuInfo | null {
  const nvidiaNames = tryExec(
    runtime,
    "nvidia-smi --query-gpu=name --format=csv,noheader,nounits 2>/dev/null",
  );
  const nvidiaMemory = tryExec(
    runtime,
    "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null",
  );
  if (nvidiaMemory) {
    const perGpuMB = nvidiaMemory
      .split(/\r?\n/)
      .map((line) => parseInt(line.trim(), 10))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (perGpuMB.length > 0) {
      const names = nvidiaNames
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const families = [...new Set(names.map(normalizeGpuFamily).filter((family): family is string => Boolean(family)))];
      return {
        type: "nvidia",
        count: perGpuMB.length,
        totalMemoryMB: perGpuMB.reduce((sum, value) => sum + value, 0),
        perGpuMB: perGpuMB[0],
        names,
        family: families[0] ?? null,
        families,
        freeDiskGB: detectDiskSpaceGB(runtime),
        nimCapable: true,
      };
    }
  }

  const nvidiaName = tryExec(
    runtime,
    "nvidia-smi --query-gpu=name --format=csv,noheader,nounits 2>/dev/null",
  );
  if (nvidiaName.includes("GB10")) {
    const totalMemoryMB = parseInt(tryExec(runtime, "free -m | awk '/Mem:/ {print $2}'"), 10) || 0;
    return {
      type: "nvidia",
      count: 1,
      totalMemoryMB,
      perGpuMB: totalMemoryMB,
      names: ["NVIDIA GB10"],
      family: "dgx-spark",
      families: ["dgx-spark"],
      freeDiskGB: detectDiskSpaceGB(runtime),
      nimCapable: true,
      spark: true,
    };
  }

  if (process.platform !== "darwin") {
    return null;
  }

  const systemProfiler = tryExec(runtime, "system_profiler SPDisplaysDataType 2>/dev/null");
  if (!systemProfiler) {
    return null;
  }

  const chipMatch = systemProfiler.match(/Chipset Model:\s*(.+)/);
  if (!chipMatch) {
    return null;
  }

  const vramMatch = systemProfiler.match(/VRAM.*?:\s*(\d+)\s*(MB|GB)/i);
  const coresMatch = systemProfiler.match(/Total Number of Cores:\s*(\d+)/);
  let memoryMB = 0;
  if (vramMatch) {
    memoryMB = parseInt(vramMatch[1], 10);
    if (vramMatch[2].toUpperCase() === "GB") {
      memoryMB *= 1024;
    }
  } else {
    memoryMB = Math.floor((parseInt(tryExec(runtime, "sysctl -n hw.memsize"), 10) || 0) / 1024 / 1024);
  }

  return {
    type: "apple",
    name: chipMatch[1].trim(),
    count: 1,
    cores: coresMatch ? parseInt(coresMatch[1], 10) : null,
    totalMemoryMB: memoryMB,
    perGpuMB: memoryMB,
    nimCapable: false,
  };
}

export function pullNimImage(model: string, runtime: NimRuntime): string {
  const candidates = getPullCandidatesForModel(model);
  if (candidates.length === 0) {
    throw new Error(`Unknown NIM model: ${model}`);
  }

  let lastError = "";
  for (const image of candidates) {
    try {
      runtime.exec(`docker pull ${image}`);
      return image;
    } catch (err) {
      lastError = extractExecErrorMessage(err);
    }
  }

  throw new Error(
    `Failed to pull a local NIM image for ${model}. Tried: ${candidates.join(", ")}${lastError ? `\n${lastError}` : ""}`,
  );
}

export function detectDiskSpaceGB(runtime: NimRuntime): number | null {
  const dockerRoot = tryExec(runtime, "docker info --format '{{.DockerRootDir}}' 2>/dev/null") || "/var/lib/docker";
  const availableKB = tryExec(runtime, `df -Pk ${shellQuote(dockerRoot)} | awk 'NR==2 {print $4}'`);
  const available = parseInt(availableKB, 10);
  if (!Number.isFinite(available) || available <= 0) {
    return null;
  }
  return Math.floor(available / 1024 / 1024);
}

function profileMatches(profile: NimProfile, gpu: GpuInfo, freeDiskGB: number | null): boolean {
  if ((profile.gpuFamilies?.length ?? 0) > 0) {
    const families = gpu.families ?? [];
    if (!families.some((family) => profile.gpuFamilies?.includes(family))) {
      return false;
    }
  }
  if ((profile.minGpuCount ?? 1) > gpu.count) {
    return false;
  }
  if ((profile.minPerGpuMemoryMB ?? 0) > gpu.perGpuMB) {
    return false;
  }
  if (freeDiskGB !== null && (profile.minDiskSpaceGB ?? 0) > freeDiskGB) {
    return false;
  }
  return true;
}

export function getCompatibleModels(gpu: GpuInfo, freeDiskGB: number | null = gpu.freeDiskGB ?? null): NimModel[] {
  return listModels()
    .filter((model) => {
      if ((model.profiles?.length ?? 0) > 0) {
        return model.profiles?.some((profile) => profileMatches(profile, gpu, freeDiskGB));
      }
      return model.minGpuMemoryMB <= gpu.totalMemoryMB;
    })
    .sort((left, right) => {
      const leftRank = left.recommendedRank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = right.recommendedRank ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.minGpuMemoryMB - right.minGpuMemoryMB;
    });
}

export function startNimContainer(
  sandboxName: string,
  model: string,
  runtime: NimRuntime,
  port = 8000,
  imageOverride?: string,
): string {
  const name = containerName(sandboxName);
  const image = imageOverride ?? getImageForModel(model);
  if (!image) {
    throw new Error(`Unknown NIM model: ${model}`);
  }

  tryExec(runtime, `docker rm -f ${name} 2>/dev/null`);
  const credentialArgs = getContainerCredentialArgs();
  const envArgs = credentialArgs.length > 0 ? `${credentialArgs.join(" ")} ` : "";
  runtime.exec(
    `docker run -d --gpus all -p ${String(port)}:8000 --name ${name} --shm-size 16g ${envArgs}${image}`,
  );
  return name;
}

export function waitForNimHealth(
  runtime: NimRuntime,
  port = 8000,
  timeoutSeconds = 300,
  sleepSeconds = 5,
): boolean {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (tryExec(runtime, `curl -sf http://localhost:${String(port)}/v1/models 2>/dev/null`)) {
      return true;
    }
    tryExec(runtime, `sleep ${String(sleepSeconds)}`);
  }
  return false;
}
