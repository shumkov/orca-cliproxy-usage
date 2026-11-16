export function selectWindows(account) {
  const result = [...(account.rich?.windows ?? [])];
  const key = window => window.id ?? window.label.toLowerCase();
  for (const basic of account.windows) {
    const index = result.findIndex(rich => key(rich) === key(basic));
    if (index < 0) result.push(basic);
    else if ((basic.observedAt ?? -Infinity) > (result[index].observedAt ?? -Infinity)) result[index] = basic;
  }
  return result;
}

export function selectDisplayWindow(account) {
  const windows = selectWindows(account);
  return windows.find(window => window.model == null) ?? windows[0];
}

export function isObservationFresh(window, now = Date.now()) {
  const observed = window?.observedAt;
  return observed != null && now - observed <= 120000 && now >= observed;
}
