import type { HardwareProfile, ModelSpec } from "./types";

const GB = 1024 ** 3;

export type PresetId = "laptop8_cpu" | "laptop16_igpu" | "desktop_3060";
export const PRESET_IDS: PresetId[] = ["laptop8_cpu", "laptop16_igpu", "desktop_3060"];

const win = { name: "Windows 11 Home", version: "10.0.22631", arch: "x86_64" };

export const PRESETS: Record<PresetId, HardwareProfile> = {
  laptop8_cpu: {
    schema_version: 1,
    os: win,
    cpu: {
      brand: "Intel Core i5-1135G7",
      physical_cores: 4,
      logical_cores: 8,
      features: ["sse4.2", "avx", "avx2", "fma"],
    },
    memory: {
      total_bytes: 8 * GB,
      available_bytes: 4.6 * GB,
      read_bandwidth_gbps: 38,
      bandwidth_source: "mock",
    },
    gpus: [],
    disks: [{ mount: "C:\\", total_bytes: 256 * GB, available_bytes: 61 * GB }],
  },
  laptop16_igpu: {
    schema_version: 1,
    os: win,
    cpu: {
      brand: "Intel Core i7-1260P",
      physical_cores: 12,
      logical_cores: 16,
      features: ["sse4.2", "avx", "avx2", "fma", "avx_vnni"],
    },
    memory: {
      total_bytes: 16 * GB,
      available_bytes: 9.8 * GB,
      read_bandwidth_gbps: 60,
      bandwidth_source: "mock",
    },
    gpus: [
      {
        name: "Intel Iris Xe Graphics",
        vendor: "intel",
        dedicated_vram_bytes: 0,
        shared_memory_bytes: 7.9 * GB,
        is_integrated: true,
        bandwidth_gbps: 60,
        bandwidth_source: "mock",
      },
    ],
    disks: [{ mount: "C:\\", total_bytes: 512 * GB, available_bytes: 184 * GB }],
  },
  desktop_3060: {
    schema_version: 1,
    os: win,
    cpu: {
      brand: "AMD Ryzen 7 5700X",
      physical_cores: 8,
      logical_cores: 16,
      features: ["sse4.2", "avx", "avx2", "fma"],
    },
    memory: {
      total_bytes: 32 * GB,
      available_bytes: 24 * GB,
      read_bandwidth_gbps: 42,
      bandwidth_source: "mock",
    },
    gpus: [
      {
        name: "NVIDIA GeForce RTX 3060",
        vendor: "nvidia",
        dedicated_vram_bytes: 12 * GB,
        shared_memory_bytes: 16 * GB,
        is_integrated: false,
        bandwidth_gbps: 360,
        bandwidth_source: "mock",
      },
    ],
    disks: [
      { mount: "C:\\", total_bytes: 1000 * GB, available_bytes: 412 * GB },
      { mount: "D:\\", total_bytes: 2000 * GB, available_bytes: 1350 * GB },
    ],
  },
};

const qwenResearch = {
  id: "Qwen-Research",
  osi_open: false,
  url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/blob/main/LICENSE",
};

const apache = { id: "Apache-2.0", osi_open: true, url: "https://www.apache.org/licenses/LICENSE-2.0" };

function spec(
  id: string,
  name: string,
  params: number,
  sizeGb: number,
  layers: number,
  kvHeads: number,
  headDim: number,
  tags: string[],
  license = apache,
  verified = true,
): ModelSpec {
  return {
    id,
    name,
    family: "qwen2.5",
    params_b: params,
    active_params_b: params,
    quant: "Q4_K_M",
    file_size_bytes: sizeGb * GB,
    n_layers: layers,
    n_kv_heads: kvHeads,
    head_dim: headDim,
    context_max: 32768,
    license,
    tags,
    verified,
  };
}

export const MODELS: ModelSpec[] = [
  spec("qwen2.5-0.5b-instruct-q4_k_m", "Qwen2.5 0.5B Instruct", 0.5, 0.4, 24, 2, 64, ["chat", "tiny"]),
  spec("qwen2.5-1.5b-instruct-q4_k_m", "Qwen2.5 1.5B Instruct", 1.5, 1.0, 28, 2, 128, ["chat"]),
  spec("qwen2.5-3b-instruct-q4_k_m", "Qwen2.5 3B Instruct", 3, 1.9, 36, 2, 128, ["chat"], qwenResearch),
  spec("qwen2.5-7b-instruct-q4_k_m", "Qwen2.5 7B Instruct", 7, 4.7, 28, 4, 128, ["chat", "coding"]),
  spec("qwen2.5-14b-instruct-q4_k_m", "Qwen2.5 14B Instruct", 14, 9.0, 48, 8, 128, ["chat", "reasoning"], apache, false),
  spec("qwen2.5-32b-instruct-q4_k_m", "Qwen2.5 32B Instruct", 32.5, 19.8, 64, 8, 128, ["chat", "large"], apache, false),
  spec("qwen2.5-72b-instruct-q4_k_m", "Qwen2.5 72B Instruct", 72.7, 44.4, 80, 8, 128, ["chat", "large"], apache, false),
];

// Mock app info. In Tauri these come from package metadata.
export const APP_INFO = {
  version: "0.2.0",
  license: "MIT",
  languages: [
    { code: "en", available: true },
    { code: "hi", available: false },
  ],
} as const;
