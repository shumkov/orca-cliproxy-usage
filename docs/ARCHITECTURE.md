# How it works

An Orca trusted worker owns the selected host, refresh queue, credential snapshots and mutation journal. The HTML panel uses strict JSON requests and never handles management keys or provider tokens. Native Orca theme tokens style the panel, including live token updates.

For local profiles, a Python standard-library collector runs on the Orca host. For SSH profiles, it runs on the chosen remote host over noninteractive SSH with verified host keys. Each collector reads that host's config and calls its own loopback management endpoint. Provider quota reads are relayed through CLIProxy's management API; the plugin does not generate completions or spend reset credits.

Account counts mean available credential entries / total credential entries, not unique people. Automatic status selection prefers available accounts with fresh usable quota, then available accounts with older usable quota, then available accounts without quota. Stable account keys break ties; unavailable accounts are a fallback only when none are available. Display selection never changes proxy routing. Missing quota is `N/A`; a real zero remains `0%`. Observation age and reset-passed labels preserve the limits of cached data.

Enabled changes require a recent authoritative credential snapshot, the same host profile/revision and account identity, plus queue-time revalidation. Rich quota reads do not change credential identity. A single per-host queue orders reads and writes. Mutation intent is journaled before sending; an ambiguous response is reconciled by readback, never by automatically repeating PATCH. A confirmed management authentication rejection pauses that profile until explicit retry. Provider relay failures are handled separately.

The panel retains observations during background reads, keeps pending switches at their requested value, and locks only the affected mutation. Host/profile changes cancel obsolete work and isolate old responses. Connection errors remain visible alongside retained data. Quota display recency does not relax credential mutation freshness or automatic ranking.

Runtime dependencies are Node built-ins supplied by Orca and Python's standard library. The TypeScript entry is loaded directly by Orca. Development dependencies are not required for installation.
