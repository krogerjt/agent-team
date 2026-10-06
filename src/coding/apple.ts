export function selectSimulatorDestination(jsonText: string, platform: string): string | undefined {
  const parsed = JSON.parse(jsonText) as { devices?: Record<string, Array<{ isAvailable?: boolean; name?: string; udid?: string; state?: string }>> };
  const devicePattern = platform === "iOS" ? /^iPhone / : platform === "tvOS" ? /Apple TV/ : platform === "watchOS" ? /^Apple Watch / : /Vision Pro/;
  const candidates = Object.entries(parsed.devices ?? {})
    .filter(([name]) => name.includes(`.${platform}-`))
    .sort(([left], [right]) => right.localeCompare(left))
    .flatMap(([, devices]) => devices)
    .filter((device) => device.isAvailable !== false && device.udid && devicePattern.test(device.name ?? ""));
  const selected = candidates.find((device) => device.state === "Booted") ?? candidates[0];
  return selected?.udid ? `platform=${platform} Simulator,id=${selected.udid}` : undefined;
}
