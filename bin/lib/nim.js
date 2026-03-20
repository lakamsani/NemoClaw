// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// NIM container management — pull, start, stop, health-check NIM images.

const runner = require("./runner");
const nimImages = require("./nim-images.json");
const MODEL_PULL_ALIASES = {
  "nvidia/nemotron-3-nano-30b-a3b": ["nvcr.io/nim/nvidia/nemotron-3-nano:latest"],
};
const MODEL_API_ALIASES = {
  "nvidia/nemotron-3-nano-30b-a3b": "nvidia/nemotron-3-nano",
};

function normalizeGpuFamily(name) {
  const value = String(name || "").toLowerCase();
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

function containerName(sandboxName) {
  return `nemoclaw-nim-${sandboxName}`;
}

function getImageForModel(modelName) {
  const entry = nimImages.models.find((m) => m.name === modelName);
  return entry ? entry.image : null;
}

function getPullCandidatesForModel(modelName) {
  const primary = getImageForModel(modelName);
  if (!primary) return [];
  return [primary, ...(MODEL_PULL_ALIASES[modelName] || [])];
}

function getServedModelForModel(modelName) {
  return MODEL_API_ALIASES[modelName] || modelName;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getContainerCredentialArgs() {
  const args = [];
  const nvidiaApiKey = (process.env.NVIDIA_API_KEY || "").trim();
  const ngcApiKey = (process.env.NGC_API_KEY || "").trim() || nvidiaApiKey;
  if (nvidiaApiKey) {
    args.push(`-e NVIDIA_API_KEY=${shellQuote(nvidiaApiKey)}`);
  }
  if (ngcApiKey) {
    args.push(`-e NGC_API_KEY=${shellQuote(ngcApiKey)}`);
  }
  return args;
}

function listModels() {
  return nimImages.models.map((m) => ({
    name: m.name,
    image: m.image,
    minGpuMemoryMB: m.minGpuMemoryMB,
    servedModel: m.servedModel || getServedModelForModel(m.name),
    recommendedRank: m.recommendedRank || Number.MAX_SAFE_INTEGER,
    recommendedFor: m.recommendedFor || [],
    profiles: m.profiles || [],
  }));
}

function detectDiskSpaceGB() {
  let dockerRoot = "";
  try {
    dockerRoot = runner.runCapture("docker info --format '{{.DockerRootDir}}'", {
      ignoreError: true,
    });
  } catch {}
  const diskPath = dockerRoot || "/var/lib/docker";
  try {
    const availableKB = runner.runCapture(`df -Pk ${shellQuote(diskPath)} | awk 'NR==2 {print $4}'`, {
      ignoreError: true,
    });
    const available = parseInt(availableKB, 10);
    if (!isNaN(available) && available > 0) {
      return Math.floor(available / 1024 / 1024);
    }
  } catch {}
  return null;
}

function profileMatches(profile, gpu, freeDiskGB) {
  const gpuFamilies = profile.gpuFamilies || [];
  if (gpuFamilies.length > 0) {
    const families = gpu.families || [];
    if (!families.some((family) => gpuFamilies.includes(family))) {
      return false;
    }
  }
  if ((profile.minGpuCount || 1) > gpu.count) {
    return false;
  }
  if ((profile.minPerGpuMemoryMB || 0) > gpu.perGpuMB) {
    return false;
  }
  if (freeDiskGB !== null && (profile.minDiskSpaceGB || 0) > freeDiskGB) {
    return false;
  }
  return true;
}

function getCompatibleModels(gpu, freeDiskGB = null) {
  return listModels()
    .filter((model) => {
      if (model.profiles.length > 0) {
        return model.profiles.some((profile) => profileMatches(profile, gpu, freeDiskGB));
      }
      return model.minGpuMemoryMB <= gpu.totalMemoryMB;
    })
    .sort((a, b) => {
      if (a.recommendedRank !== b.recommendedRank) {
        return a.recommendedRank - b.recommendedRank;
      }
      return a.minGpuMemoryMB - b.minGpuMemoryMB;
    });
}

function detectGpu() {
  // Try NVIDIA first — query VRAM
  try {
    const nameOutput = runner.runCapture(
      "nvidia-smi --query-gpu=name --format=csv,noheader,nounits",
      { ignoreError: true }
    );
    const output = runner.runCapture(
      "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits",
      { ignoreError: true }
    );
    if (output) {
      const lines = output.split("\n").filter((l) => l.trim());
      const perGpuMB = lines.map((l) => parseInt(l.trim(), 10)).filter((n) => !isNaN(n));
      const names = nameOutput.split("\n").map((line) => line.trim()).filter(Boolean);
      const families = [...new Set(names.map(normalizeGpuFamily).filter(Boolean))];
      if (perGpuMB.length > 0) {
        const totalMemoryMB = perGpuMB.reduce((a, b) => a + b, 0);
        return {
          type: "nvidia",
          count: perGpuMB.length,
          totalMemoryMB,
          perGpuMB: perGpuMB[0],
          names,
          family: families[0] || null,
          families,
          freeDiskGB: detectDiskSpaceGB(),
          nimCapable: true,
        };
      }
    }
  } catch {}

  // Fallback: DGX Spark (GB10) — VRAM not queryable due to unified memory architecture
  try {
    const nameOutput = runner.runCapture(
      "nvidia-smi --query-gpu=name --format=csv,noheader,nounits",
      { ignoreError: true }
    );
    if (nameOutput && nameOutput.includes("GB10")) {
      // GB10 has 128GB unified memory shared with Grace CPU — use system RAM
      let totalMemoryMB = 0;
      try {
        const memLine = runner.runCapture("free -m | awk '/Mem:/ {print $2}'", { ignoreError: true });
        if (memLine) totalMemoryMB = parseInt(memLine.trim(), 10) || 0;
      } catch {}
      return {
        type: "nvidia",
        count: 1,
        totalMemoryMB,
        perGpuMB: totalMemoryMB,
        names: ["NVIDIA GB10"],
        family: "dgx-spark",
        families: ["dgx-spark"],
        freeDiskGB: detectDiskSpaceGB(),
        nimCapable: true,
        spark: true,
      };
    }
  } catch {}

  // macOS: detect Apple Silicon or discrete GPU
  if (process.platform === "darwin") {
    try {
      const spOutput = runner.runCapture(
        "system_profiler SPDisplaysDataType 2>/dev/null",
        { ignoreError: true }
      );
      if (spOutput) {
        const chipMatch = spOutput.match(/Chipset Model:\s*(.+)/);
        const vramMatch = spOutput.match(/VRAM.*?:\s*(\d+)\s*(MB|GB)/i);
        const coresMatch = spOutput.match(/Total Number of Cores:\s*(\d+)/);

        if (chipMatch) {
          const name = chipMatch[1].trim();
          let memoryMB = 0;

          if (vramMatch) {
            memoryMB = parseInt(vramMatch[1], 10);
            if (vramMatch[2].toUpperCase() === "GB") memoryMB *= 1024;
          } else {
            // Apple Silicon shares system RAM — read total memory
            try {
              const memBytes = runner.runCapture("sysctl -n hw.memsize", { ignoreError: true });
              if (memBytes) memoryMB = Math.floor(parseInt(memBytes, 10) / 1024 / 1024);
            } catch {}
          }

          return {
            type: "apple",
            name,
            count: 1,
            cores: coresMatch ? parseInt(coresMatch[1], 10) : null,
            totalMemoryMB: memoryMB,
            perGpuMB: memoryMB,
            nimCapable: false,
          };
        }
      }
    } catch {}
  }

  return null;
}

function pullNimImage(model) {
  const images = getPullCandidatesForModel(model);
  if (images.length === 0) {
    console.error(`  Unknown model: ${model}`);
    process.exit(1);
  }

  let lastError = null;
  for (const image of images) {
    console.log(`  Pulling NIM image: ${image}`);
    const result = runner.run(`docker pull ${image}`, { ignoreError: true });
    if (result.status === 0) {
      return image;
    }
    lastError = new Error(`docker pull failed for ${image} (exit ${result.status || 1})`);
  }

  if (lastError) {
    throw lastError;
  }
  return null;
}

function startNimContainer(sandboxName, model, port = 8000, imageOverride = null) {
  const name = containerName(sandboxName);
  const image = imageOverride || getImageForModel(model);
  if (!image) {
    console.error(`  Unknown model: ${model}`);
    process.exit(1);
  }

  // Stop any existing container with same name
  runner.run(`docker rm -f ${name} 2>/dev/null || true`, { ignoreError: true });

  console.log(`  Starting NIM container: ${name}`);
  const envArgs = getContainerCredentialArgs();
  runner.run(
    `docker run -d --gpus all -p ${port}:8000 --name ${name} --shm-size 16g ${envArgs.join(" ")} ${image}`.trim()
  );
  return name;
}

function waitForNimHealth(port = 8000, timeout = 300) {
  const start = Date.now();
  const interval = 5000;
  console.log(`  Waiting for NIM health on port ${port} (timeout: ${timeout}s)...`);

  while ((Date.now() - start) / 1000 < timeout) {
    try {
      const result = runner.runCapture(`curl -sf http://localhost:${port}/v1/models`, {
        ignoreError: true,
      });
      if (result) {
        console.log("  NIM is healthy.");
        return true;
      }
    } catch {}
    // Synchronous sleep via spawnSync
    require("child_process").spawnSync("sleep", ["5"]);
  }
  console.error(`  NIM did not become healthy within ${timeout}s.`);
  return false;
}

function stopNimContainer(sandboxName) {
  const name = containerName(sandboxName);
  console.log(`  Stopping NIM container: ${name}`);
  runner.run(`docker stop ${name} 2>/dev/null || true`, { ignoreError: true });
  runner.run(`docker rm ${name} 2>/dev/null || true`, { ignoreError: true });
}

function nimStatus(sandboxName) {
  const name = containerName(sandboxName);
  try {
    const state = runner.runCapture(
      `docker inspect --format '{{.State.Status}}' ${name} 2>/dev/null`,
      { ignoreError: true }
    );
    if (!state) return { running: false, container: name };

    let healthy = false;
    if (state === "running") {
      const health = runner.runCapture(`curl -sf http://localhost:8000/v1/models 2>/dev/null`, {
        ignoreError: true,
      });
      healthy = !!health;
    }
    return { running: state === "running", healthy, container: name, state };
  } catch {
    return { running: false, container: name };
  }
}

module.exports = {
  containerName,
  getImageForModel,
  getServedModelForModel,
  listModels,
  detectGpu,
  detectDiskSpaceGB,
  getCompatibleModels,
  pullNimImage,
  startNimContainer,
  waitForNimHealth,
  stopNimContainer,
  nimStatus,
};
