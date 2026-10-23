export type GpuVendor = "nvidia" | "amd" | "intel" | "other";

export interface AppPaths {
  data_dir: string;
  data_dir_exists: boolean;
}

export interface CatalogInfo {
  generated_at: string;
  families: string[];
  subscribed_families: string[];
  refresh_catalog_always_allowed: boolean;
  warning: string | null;
  signature_verified: boolean;
}

export interface CatalogRefreshResult {
  generated_at: string;
  model_count: number;
  added: number;
  updated: number;
}

export interface GpuInfo {
  name: string;
  vendor: GpuVendor;
  dedicated_vram_bytes: number;
  shared_memory_bytes: number;
  is_integrated: boolean;
  bandwidth_gbps: number | null;
  bandwidth_source: string;
}

export interface HardwareProfile {
  schema_version: number;
  os: { name: string; version: string; arch: string };
  cpu: {
    brand: string;
    physical_cores: number;
    logical_cores: number;
    features: string[];
  };
  memory: {
    total_bytes: number;
    available_bytes: number;
    read_bandwidth_gbps: number | null;
    bandwidth_source: string;
  };
  gpus: GpuInfo[];
  disks: { mount: string; total_bytes: number; available_bytes: number }[];
}

export type Fit = "great" | "good" | "slow" | "too_slow" | "wont_fit";

export type Placement =
  | { kind: "full_gpu" }
  | { kind: "partial_gpu"; gpu_layers: number; total_layers: number }
  | { kind: "cpu_only" }
  | { kind: "no_fit" };

export interface ModelSpec {
  id: string;
  name: string;
  family: string;
  params_b: number;
  active_params_b: number;
  quant: string;
  file_size_bytes: number;
  n_layers: number;
  n_kv_heads: number;
  head_dim: number;
  context_max: number;
  license: { id: string; osi_open: boolean; url: string };
  tags: string[];
  verified: boolean;
}

export interface Estimate {
  model_id: string;
  placement: Placement;
  fit: Fit;
  decode_tps: number;
  memory_required_bytes: number;
  weights_bytes: number;
  kv_cache_bytes: number;
  overhead_bytes: number;
  context: number;
  confidence: "estimated" | "measured";
  reasons: string[];
}

export interface Recommendation {
  model: ModelSpec;
  estimate: Estimate;
  rank: number;
  badges: string[];
}
