"""Host-local, standard-library-only CLIProxy collector. Never emit raw responses."""

import datetime
import hashlib
import ipaddress
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_BODY = 4 * 1024 * 1024


class Failure(Exception):
    def __init__(self, code, message, status=None, retry_at=None):
        self.code = code
        self.message = message
        self.status = status
        self.retry_at = retry_at


def text(value, limit=256):
    return "".join(c for c in value if c >= " " and c != "\x7f")[:limit] if isinstance(value, str) else None


def number(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def timestamp(value):
    if isinstance(value, str) and not number(value):
        try:
            date = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
            return date.timestamp() * 1000 if date.tzinfo else None
        except (ValueError, OverflowError):
            return None
    value = number(value)
    return value * 1000 if value is not None and value > 0 else None


def reset_time(data, observed):
    absolute = timestamp(data.get("reset_at") or data.get("resets_at"))
    after = number(data.get("reset_after_seconds"))
    return absolute or (observed + after * 1000 if after is not None and observed is not None else None)


def window(label, used, reset, observed, minutes=None, model=None, window_id=None):
    used = number(used)
    return {"id": window_id or label, "label": text(label), "usedPercent": max(0, min(100, used)) if used is not None else None,
            "resetAt": reset, "observedAt": observed, "minutes": minutes, "model": text(model)}


def signal_windows(quota, provider, model=None):
    if not isinstance(quota, dict):
        return []
    observed = timestamp(quota.get("observed_at"))
    if observed is None:
        return []
    signals = {str(k).lower(): v for k, v in quota.get("signals", {}).items()}
    result = []
    if provider == "codex":
        for kind in ("primary", "secondary"):
            prefix = "x-codex-%s-" % kind
            minutes = number(signals.get(prefix + "window-minutes"))
            if minutes is None or minutes <= 0:
                continue
            reset = reset_time({"reset_at": signals.get(prefix + "reset-at"), "reset_after_seconds": signals.get(prefix + "reset-after-seconds")}, observed)
            result.append(window(kind.title(), signals.get(prefix + "used-percent"), reset, observed, minutes, model, kind + "_window"))
    elif provider == "claude":
        for key, label, minutes in (("5h", "5 hours", 300), ("7d", "7 days", 10080)):
            prefix = "anthropic-ratelimit-unified-%s-" % key
            used = number(signals.get(prefix + "utilization"))
            if used is not None or prefix + "reset" in signals:
                result.append(window(label, used * 100 if used is not None else None, timestamp(signals.get(prefix + "reset")), observed, minutes, model, "five_hour" if key == "5h" else "seven_day"))
    return result


def codex_plan(value):
    return {"pro": "Pro 200", "prolite": "Pro 100", "promax": "Pro 500", "plus": "Plus", "team": "Team", "free": "Free"}.get(value, text(value))


def normalize(entry):
    provider = text(entry.get("provider")) or "unknown"
    index = text(entry.get("auth_index"))
    name = text(entry.get("name"), 1024)
    identity = {"authIndex": index, "name": name}
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    cooldowns = []
    all_cooldowns = entry.get("cooldowns", [])
    if not isinstance(all_cooldowns, list):
        all_cooldowns = [{"scope": "unknown"}]
    for item in all_cooldowns[:100]:
        if isinstance(item, dict):
            cooldowns.append({"scope": text(item.get("scope")) or "unknown", "model": text(item.get("model_key")),
                              "reason": text(item.get("reason")), "retryAt": timestamp(item.get("retry_at")), "httpStatus": number(item.get("http_status"))})
    status = text(entry.get("status")) or "unknown"
    disabled = entry.get("disabled") if isinstance(entry.get("disabled"), bool) else None
    available = (status == "active" and disabled is False and not any(entry.get(k) for k in ("quota_blocked", "requires_sign_in", "unavailable"))
                 and not any(not isinstance(c, dict) or c.get("scope") != "model" for c in all_cooldowns))
    quota = entry.get("quota") or {}
    signals = {str(k).lower(): v for k, v in quota.get("signals", {}).items()}
    models = []
    model_quotas = entry.get("model_quotas") or {}
    for model, value in list(model_quotas.items())[:100]:
        models.extend(signal_windows(value, provider, model))
    recent = [{"label": text(x.get("time")), "success": number(x.get("success")), "failed": number(x.get("failed"))}
              for x in entry.get("recent_requests", [])[:100] if isinstance(x, dict)]
    return {"key": key, "identity": identity, "provider": provider, "email": text(entry.get("email")) or name or "Unnamed credential",
            "name": name, "status": status, "disabled": disabled, "available": available,
            "requiresSignIn": entry.get("requires_sign_in") is True, "quotaBlocked": entry.get("quota_blocked") is True,
            "unavailable": entry.get("unavailable") is True, "priority": number(entry.get("priority")),
            "windows": signal_windows(quota, provider), "modelWindows": models, "cooldowns": cooldowns, "recent": recent,
            "plan": codex_plan(signals.get("x-codex-plan-type")) if provider == "codex" else None,
            "credits": {"balance": number(signals.get("x-codex-credits-balance")), "unlimited": str(signals.get("x-codex-credits-unlimited", "")).lower() == "true"} if provider == "codex" else None}


def normalize_rich(provider, responses, observed):
    usage = responses.get("usage") or {}
    windows = []
    plan = None
    credits = None
    entitlement = None
    if provider == "claude":
        for key in ("five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet", "seven_day_cowork", "iguana_necktie"):
            value = usage.get(key)
            if isinstance(value, dict):
                windows.append(window(key.replace("_", " ").title(), value.get("utilization"), timestamp(value.get("resets_at")), observed, window_id=key))
        profile = responses.get("profile") or {}
        org = profile.get("organization") or {}
        account = profile.get("account") or {}
        tier = text(org.get("rate_limit_tier"))
        if org.get("organization_type") == "claude_team" and org.get("subscription_status") == "active":
            plan = "Team"
        elif tier and tier.endswith("claude_max_20x"):
            plan = "Max 20x"
        elif tier and tier.endswith("claude_max_5x"):
            plan = "Max 5x"
        elif account.get("has_claude_max") is True:
            plan = "Max"
        elif account.get("has_claude_pro") is True:
            plan = "Pro"
        elif account.get("has_claude_max") is False and account.get("has_claude_pro") is False:
            plan = "Free"
        else:
            plan = tier
    else:
        plan = codex_plan(usage.get("plan_type"))
        limits = [("", usage.get("rate_limit")), ("Code review ", usage.get("code_review_rate_limit"))]
        for item in (usage.get("additional_rate_limits") or [])[:50]:
            if isinstance(item, dict):
                limits.append(((text(item.get("limit_name")) or "Additional") + " ", item.get("rate_limit")))
        for prefix, limit in limits:
            if not isinstance(limit, dict):
                continue
            for key in ("primary_window", "secondary_window"):
                value = limit.get(key)
                if not isinstance(value, dict):
                    continue
                seconds = number(value.get("limit_window_seconds"))
                if seconds is not None and seconds <= 0:
                    continue
                windows.append(window(prefix + key.replace("_", " ").title(), value.get("used_percent"), reset_time(value, observed), observed, seconds / 60 if seconds else None, window_id=prefix + key))
        raw_credits = usage.get("credits")
        if isinstance(raw_credits, dict):
            credits = {"balance": number(raw_credits.get("balance")), "unlimited": raw_credits.get("unlimited") is True}
        resets = responses.get("resets") or usage.get("rate_limit_reset_credits")
        if isinstance(resets, dict):
            entitlement = {"available": number(resets.get("available_count", resets.get("availableCount"))),
                           "applicable": number(resets.get("applicable_available_count", resets.get("applicableAvailableCount"))),
                           "expiresAt": [timestamp(x.get("expires_at", x.get("expiresAt"))) for x in resets.get("credits", [])[:100]
                                         if isinstance(x, dict) and x.get("reset_type", x.get("resetType")) == "codex_rate_limits" and x.get("status") == "available"]}
    return {"windows": windows, "plan": plan, "credits": credits, "resetEntitlements": entitlement,
            "subscriptionUntil": timestamp((responses.get("subscription") or {}).get("active_until")), "observedAt": observed}


def validate_base(value):
    try:
        parts = urllib.parse.urlsplit(value)
        valid = parts.scheme in ("http", "https") and ipaddress.ip_address(parts.hostname).is_loopback and parts.port is not None
        valid = valid and not (parts.username or parts.password or parts.query or parts.fragment) and parts.path in ("", "/")
        if valid:
            return value.rstrip("/")
    except (ValueError, TypeError):
        pass
    raise Failure("configuration", "Management URL must be a literal loopback HTTP(S) URL with an explicit port")


def local_path(value):
    if not isinstance(value, str) or len(value) > 4096 or any(c in value for c in "\x00\r\n") or not (value.startswith("/") or value.startswith("~/")):
        raise Failure("configuration", "Config and secret paths must be absolute or home-relative")
    return os.path.expanduser(value)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    def __init__(self, profile):
        self.base = validate_base(profile.get("baseUrl")) + "/v8/management"
        try:
            with open(local_path(profile.get("configPath")), encoding="utf-8") as handle:
                raw = handle.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise Failure("configuration", "Configuration is too large")
            try:
                config = json.loads(raw)
            except ValueError:
                raise Failure("configuration", "Only JSON-formatted proxy configuration is supported; YAML is not supported")
            key = (config.get("remote-management") or {}).get("secret-key")
            if profile.get("secretPath"):
                with open(local_path(profile["secretPath"]), encoding="utf-8") as handle:
                    key = handle.read(8193).strip()
            if not isinstance(key, str) or not key or len(key) > 8192 or "\n" in key or "\r" in key:
                raise Failure("configuration", "A host-local plaintext management credential is required")
            if key.startswith(("$2a$", "$2b$", "$2y$", "$argon2")):
                raise Failure("configuration", "The configured key is a hash; provide a host-local plaintext secretPath")
            self.key = key
        except OSError:
            raise Failure("configuration", "Could not read host-local configuration or secret file")
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, path, body=None):
        request = urllib.request.Request(self.base + path, method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Authorization": "Bearer " + self.key, "Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=8) as response:
                raw = response.read(MAX_BODY + 1)
                if len(raw) > MAX_BODY:
                    raise Failure("too_large", "Management response exceeded the size limit")
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            retry = retry_after(error.headers)
            error.close()
            if error.code in (401, 403):
                raise Failure("authentication", "Management authentication rejected; automatic requests stopped", error.code)
            raise Failure("http", "Management HTTP %d" % error.code, error.code, retry)
        except (OSError, ValueError, TimeoutError):
            raise Failure("transport", "Management response unavailable")

    def credentials(self):
        result = self.request("GET", "/credentials")
        files = result.get("files") if isinstance(result, dict) else None
        if not isinstance(files, list) or len(files) > 500 or any(not isinstance(x, dict) for x in files):
            raise Failure("schema", "Unsupported credentials response")
        return files


def retry_after(headers):
    if not isinstance(headers, (dict, type(urllib.request.Request("http://127.0.0.1").headers))) and not hasattr(headers, "items"):
        return None
    value = next((v for k, v in headers.items() if k.lower() == "retry-after"), None)
    if isinstance(value, list):
        value = value[0] if value else None
    seconds = number(value)
    if seconds is not None:
        return time.time() * 1000 + max(0, seconds) * 1000
    if isinstance(value, str):
        try:
            import email.utils
            return email.utils.parsedate_to_datetime(value).timestamp() * 1000
        except (TypeError, ValueError):
            pass
    return None


def find_entry(entries, identity):
    matches = [x for x in entries if x.get("name") == identity.get("name") and x.get("auth_index") == identity.get("authIndex")]
    if len(matches) != 1 or not identity.get("name") or not identity.get("authIndex"):
        raise Failure("stale", "Credential identity changed or is ambiguous; refresh the list")
    return matches[0]


def enrich(client, entry):
    provider = entry.get("provider")
    if provider not in ("claude", "codex"):
        return {"error": "Quota enrichment is unavailable for this provider", "windows": [], "observedAt": time.time() * 1000}
    observed = time.time() * 1000
    headers = {"Authorization": "Bearer $TOKEN$", "Content-Type": "application/json", "Accept": "application/json"}
    if provider == "claude":
        headers.update({"anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-cli/2.1.280 (external, cli)"})
        operations = [("usage", "https://api.anthropic.com/api/oauth/usage"), ("profile", "https://api.anthropic.com/api/oauth/profile")]
    else:
        headers["User-Agent"] = "codex-tui/0.149.1"
        account_id = entry.get("account_id")
        # JWT claims, if needed, stay within the selected host.
        if not account_id and isinstance(entry.get("id_token"), str):
            try:
                import base64
                part = entry["id_token"].split(".")[1]
                claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
                account_id = (claims.get("https://api.openai.com/auth") or {}).get("chatgpt_account_id")
            except (ValueError, IndexError, TypeError):
                pass
        if isinstance(account_id, str) and len(account_id) <= 256 and not any(c in account_id for c in "\r\n"):
            headers["Chatgpt-Account-Id"] = account_id
        operations = [("usage", "https://chatgpt.com/backend-api/wham/usage")]
        if "Chatgpt-Account-Id" in headers:
            operations.append(("subscription", "https://chatgpt.com/backend-api/subscriptions?" + urllib.parse.urlencode({"account_id": account_id})))
        operations.append(("resets", "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"))
    responses = {}
    errors = []
    retry_at = None
    for name, url in operations:
        call_headers = dict(headers)
        if name == "resets":
            call_headers.update({"OpenAI-Beta": "codex-1", "Originator": "Codex Desktop"})
        try:
            result = client.request("POST", "/requests/api-call", {"authIndex": entry["auth_index"], "method": "GET", "url": url, "header": call_headers})
            status = result.get("status_code")
            if not isinstance(status, int) or isinstance(status, bool):
                errors.append("Provider returned an unsupported status")
                break
            if not 200 <= status < 300:
                errors.append("Provider authentication rejected (%s)" % status if status in (401, 403) else "Provider %s HTTP %s" % (name, status))
                retry_at = retry_after(result.get("header", {}))
                if status in (401, 403, 429) or retry_at:
                    break
                continue
            body = result.get("body")
            if isinstance(body, str):
                body = json.loads(body)
            if isinstance(body, dict):
                responses[name] = body
            else:
                errors.append("Provider %s returned an unsupported response" % name)
        except Failure as error:
            # Outer management failures invalidate host freshness; provider status is nested.
            raise
        except (ValueError, TypeError):
            errors.append("Provider %s returned an unsupported response" % name)
    try:
        rich = normalize_rich(provider, responses, observed)
    except (TypeError, ValueError, AttributeError, KeyError):
        rich = {"windows": [], "observedAt": observed}
        errors.append("Provider returned unsupported quota data")
    if errors:
        rich["error"] = "; ".join(errors)
        rich["retryAt"] = retry_at
    return rich


def collect(request):
    try:
        client = Client(request["profile"])
        operation = request.get("operation")
        if operation not in ("read", "rich", "toggle"):
            raise Failure("input", "Unsupported collector operation")
        entries = client.credentials()
        mutation = None
        rich = None
        if operation in ("rich", "toggle"):
            entry = find_entry(entries, request.get("identity") or {})
            if operation == "rich":
                rich = enrich(client, entry)
            else:
                desired = request.get("disabled")
                if not isinstance(desired, bool):
                    raise Failure("input", "Enabled must be a boolean")
                if entry.get("disabled") != desired:
                    try:
                        client.request("PATCH", "/credentials/status", {"name": entry["name"], "auth_index": entry["auth_index"], "disabled": desired})
                    except Failure as error:
                        if error.code == "authentication":
                            raise
                        # A failed response may follow a persisted write. Never repeat PATCH.
                        pass
                try:
                    entries = client.credentials()
                    verified = find_entry(entries, request["identity"])
                    mutation = "confirmed" if verified.get("disabled") == desired else "not_applied"
                except Failure as error:
                    if error.code == "authentication":
                        raise
                    mutation = "unconfirmed"
        result = {"accounts": [normalize(x) for x in entries], "observedAt": time.time() * 1000}
        if mutation:
            result["mutation"] = mutation
        if rich:
            result["rich"] = rich
        return result
    except Failure as error:
        result = {"error": error.message, "code": error.code}
        if error.code == "authentication":
            result["authRejected"] = True
        if error.retry_at:
            result["retryAt"] = error.retry_at
        return result
    except Exception:
        return {"error": "Collector could not process the host response", "code": "schema"}


def main(request):
    result = collect(request)
    encoded = json.dumps(result, allow_nan=False)
    if len(encoded.encode()) > 900 * 1024:
        encoded = json.dumps({"error": "Normalized response exceeded the size limit", "code": "too_large"})
    print(encoded)
