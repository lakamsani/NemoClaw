"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createNimRuntime = createNimRuntime;
exports.getServedModelForModel = getServedModelForModel;
exports.containerName = containerName;
exports.listModels = listModels;
exports.getImageForModel = getImageForModel;
exports.detectGpu = detectGpu;
exports.pullNimImage = pullNimImage;
exports.detectDiskSpaceGB = detectDiskSpaceGB;
exports.getCompatibleModels = getCompatibleModels;
exports.startNimContainer = startNimContainer;
exports.waitForNimHealth = waitForNimHealth;
const node_child_process_1 = require("node:child_process");
const nim_images_json_1 = __importDefault(require("../../../bin/lib/nim-images.json"));
const MODEL_PULL_ALIASES = {
    "nvidia/nemotron-3-nano-30b-a3b": ["nvcr.io/nim/nvidia/nemotron-3-nano:latest"],
};
const MODEL_API_ALIASES = {
    "nvidia/nemotron-3-nano-30b-a3b": "nvidia/nemotron-3-nano",
};
function normalizeGpuFamily(name) {
    const value = name.toLowerCase();
    if (value.includes("gb10") || value.includes("dgx spark"))
        return "dgx-spark";
    if (value.includes("gb200"))
        return "gb200";
    if (value.includes("b200"))
        return "b200";
    if (value.includes("gh200"))
        return "gh200";
    if (value.includes("h200"))
        return "h200";
    if (value.includes("h100"))
        return "h100";
    if (value.includes("h20"))
        return "h20";
    if (value.includes("l40s"))
        return "l40s";
    if (value.includes("a10g"))
        return "a10g";
    if (value.includes("a100"))
        return "a100";
    if (value.includes("rtx 6000 ada"))
        return "rtx6000-ada";
    if (value.includes("blackwell server edition"))
        return "rtx-pro-6000-blackwell";
    if (value.includes("rtx 5090"))
        return "rtx5090";
    if (value.includes("rtx 4090"))
        return "rtx4090";
    return null;
}
function createNimRuntime() {
    return {
        exec(command) {
            return (0, node_child_process_1.execSync)(command, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], shell: "/bin/bash" });
        },
    };
}
function tryExec(runtime, command) {
    try {
        return runtime.exec(command).trim();
    }
    catch {
        return "";
    }
}
function extractExecErrorMessage(err) {
    if (!err || typeof err !== "object") {
        return String(err);
    }
    const stderr = "stderr" in err ? String(err.stderr ?? "") : "";
    const message = "message" in err ? String(err.message ?? "") : "";
    return `${message}\n${stderr}`.trim();
}
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function getPullCandidatesForModel(modelName) {
    const primary = getImageForModel(modelName);
    if (!primary) {
        return [];
    }
    return [primary, ...(MODEL_PULL_ALIASES[modelName] ?? [])];
}
function getServedModelForModel(modelName) {
    return MODEL_API_ALIASES[modelName] ?? modelName;
}
function getContainerCredentialArgs() {
    const credentials = [];
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
function containerName(sandboxName) {
    return `nemoclaw-nim-${sandboxName}`;
}
function listModels() {
    return nim_images_json_1.default.models.map((model) => ({
        name: model.name,
        image: model.image,
        minGpuMemoryMB: model.minGpuMemoryMB,
        servedModel: model.servedModel ?? getServedModelForModel(model.name),
        recommendedRank: model.recommendedRank ?? Number.MAX_SAFE_INTEGER,
        recommendedFor: model.recommendedFor ?? [],
        profiles: model.profiles ?? [],
    }));
}
function getImageForModel(modelName) {
    return listModels().find((model) => model.name === modelName)?.image ?? null;
}
function detectGpu(runtime) {
    const nvidiaNames = tryExec(runtime, "nvidia-smi --query-gpu=name --format=csv,noheader,nounits 2>/dev/null");
    const nvidiaMemory = tryExec(runtime, "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null");
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
            const families = [...new Set(names.map(normalizeGpuFamily).filter((family) => Boolean(family)))];
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
    const nvidiaName = tryExec(runtime, "nvidia-smi --query-gpu=name --format=csv,noheader,nounits 2>/dev/null");
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
    }
    else {
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
function pullNimImage(model, runtime) {
    const candidates = getPullCandidatesForModel(model);
    if (candidates.length === 0) {
        throw new Error(`Unknown NIM model: ${model}`);
    }
    let lastError = "";
    for (const image of candidates) {
        try {
            runtime.exec(`docker pull ${image}`);
            return image;
        }
        catch (err) {
            lastError = extractExecErrorMessage(err);
        }
    }
    throw new Error(`Failed to pull a local NIM image for ${model}. Tried: ${candidates.join(", ")}${lastError ? `\n${lastError}` : ""}`);
}
function detectDiskSpaceGB(runtime) {
    const dockerRoot = tryExec(runtime, "docker info --format '{{.DockerRootDir}}' 2>/dev/null") || "/var/lib/docker";
    const availableKB = tryExec(runtime, `df -Pk ${shellQuote(dockerRoot)} | awk 'NR==2 {print $4}'`);
    const available = parseInt(availableKB, 10);
    if (!Number.isFinite(available) || available <= 0) {
        return null;
    }
    return Math.floor(available / 1024 / 1024);
}
function profileMatches(profile, gpu, freeDiskGB) {
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
function getCompatibleModels(gpu, freeDiskGB = gpu.freeDiskGB ?? null) {
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
function startNimContainer(sandboxName, model, runtime, port = 8000, imageOverride) {
    const name = containerName(sandboxName);
    const image = imageOverride ?? getImageForModel(model);
    if (!image) {
        throw new Error(`Unknown NIM model: ${model}`);
    }
    tryExec(runtime, `docker rm -f ${name} 2>/dev/null`);
    const credentialArgs = getContainerCredentialArgs();
    const envArgs = credentialArgs.length > 0 ? `${credentialArgs.join(" ")} ` : "";
    runtime.exec(`docker run -d --gpus all -p ${String(port)}:8000 --name ${name} --shm-size 16g ${envArgs}${image}`);
    return name;
}
function waitForNimHealth(runtime, port = 8000, timeoutSeconds = 300, sleepSeconds = 5) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
        if (tryExec(runtime, `curl -sf http://localhost:${String(port)}/v1/models 2>/dev/null`)) {
            return true;
        }
        tryExec(runtime, `sleep ${String(sleepSeconds)}`);
    }
    return false;
}
//# sourceMappingURL=nim.js.map