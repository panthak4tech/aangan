import { useEffect, useState } from "react";
import { getDevPreset, getFailScans, setDevPreset, setFailScans } from "@/api/devPreset";
import { PRESET_IDS, type PresetId } from "@/api/presets";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/primitives/select";
import { Switch } from "@/components/primitives/switch";
import { en } from "@/i18n/en";

export function DevPresetSwitch() {
  const [value, setValue] = useState<PresetId>("desktop_3060");
  const [fail, setFail] = useState(false);
  useEffect(() => {
    setValue(getDevPreset());
    setFail(getFailScans());
  }, []);
  if (!import.meta.env.DEV) return null;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-dashed border-border bg-muted px-3 py-1.5">
      <span className="text-xs font-medium text-muted-foreground">{en.dev.label}</span>
      <Select
        value={value}
        onValueChange={(v) => {
          setDevPreset(v as PresetId);
          setValue(v as PresetId);
        }}
      >
        <SelectTrigger className="h-8 w-64 bg-card text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESET_IDS.map((id) => (
            <SelectItem key={id} value={id} className="text-xs">
              {en.dev.presets[id]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          checked={fail}
          onCheckedChange={(v) => {
            setFailScans(v);
            setFail(v);
          }}
        />
        {en.dev.failScan}
      </label>
    </div>
  );
}
