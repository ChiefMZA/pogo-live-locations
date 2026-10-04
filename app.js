"use strict";

const state = {
  data: { hotspots: [], timezones: [] },
  activeTab: "hotspots",
  query: "",
  offsetSignature: "",
};

const elements = {
  groups: document.querySelector("#location-groups"),
  search: document.querySelector("#location-search"),
  summary: document.querySelector("#list-summary"),
  toast: document.querySelector("#toast"),
  localClock: document.querySelector("#local-clock"),
  localZone: document.querySelector("#local-zone"),
  timezoneCount: document.querySelector('[data-count="timezones"]'),
  tabs: [...document.querySelectorAll("[data-tab]")],
};

const formatterCache = new Map();
const copyTimers = new WeakMap();
let toastTimer;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function flagMarkup(countryCode, locationName) {
  if (!/^[A-Z]{2}$/.test(countryCode || "")) {
    return '<span class="flag-fallback" aria-hidden="true">🌐</span>';
  }
  const code = countryCode.toLowerCase();
  return `<img class="flag-image" src="https://flagcdn.com/w80/${code}.png" srcset="https://flagcdn.com/w160/${code}.png 2x" alt="" loading="lazy" decoding="async"><span class="visually-hidden">Flag for ${escapeHtml(locationName)}</span>`;
}

function formatter(timeZone, kind) {
  const key = `${timeZone}:${kind}`;
  if (formatterCache.has(key)) return formatterCache.get(key);
  const options = kind === "clock"
    ? { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }
    : kind === "date"
      ? { timeZone, weekday: "short", day: "2-digit", month: "short", year: "numeric" }
      : { timeZone, timeZoneName: "short" };
  const value = new Intl.DateTimeFormat(kind === "clock" ? "en-US" : undefined, options);
  formatterCache.set(key, value);
  return value;
}

function zoneAbbreviation(timeZone, date) {
  const value = formatter(timeZone, "zone").formatToParts(date)
    .find((part) => part.type === "timeZoneName");
  return value ? value.value : timeZone;
}

function offsetMinutes(timeZone, date) {
  const value = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type) => Number(value.find((item) => item.type === type).value);
  const localAsUtc = Date.UTC(
    part("year"), part("month") - 1, part("day"),
    part("hour"), part("minute"), part("second"),
  );
  return Math.round((localAsUtc - date.getTime()) / 60000);
}

function offsetLabel(minutes) {
  const sign = minutes >= 0 ? "+" : "−";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function isValidLocation(location) {
  if (!location || typeof location !== "object") return false;
  if (typeof location.id !== "string" || location.id.length > 80) return false;
  if (typeof location.name !== "string" || !location.name.trim() || location.name.length > 200) return false;
  if (typeof location.timezone !== "string" || location.timezone.length > 100) return false;
  if (!/^[A-Z]{2}$/.test(location.countryCode || "")) return false;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return false;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: location.timezone }).format();
  } catch {
    return false;
  }
  return true;
}

function visibleLocations() {
  const query = state.query.trim().toLocaleLowerCase();
  if (!query) return state.data[state.activeTab];
  return state.data[state.activeTab].filter((location) =>
    `${location.name} ${location.timezone} ${location.latitude} ${location.longitude}`
      .toLocaleLowerCase().includes(query)
  );
}

function groupedLocations(date, locations = visibleLocations()) {
  const groups = new Map();
  for (const location of locations) {
    let offset;
    try {
      offset = offsetMinutes(location.timezone, date);
    } catch {
      offset = 0;
    }
    if (!groups.has(offset)) groups.set(offset, []);
    groups.get(offset).push(location);
  }
  return [...groups.entries()]
    .sort(([first], [second]) => second - first)
    .map(([offset, locations]) => [
      offset,
      locations.sort((a, b) =>
        a.timezone.localeCompare(b.timezone) || a.name.localeCompare(b.name)
      ),
    ]);
}

function rowTemplate(location) {
  const coordinate = `${Number(location.latitude).toFixed(6)}, ${Number(location.longitude).toFixed(6)}`;
  const name = escapeHtml(location.name);
  const timezone = escapeHtml(location.timezone);
  return `
    <article class="location-row" data-timezone="${timezone}">
      <div class="place">
        <span class="flag">${flagMarkup(location.countryCode, location.name)}</span>
        <div>
          <div class="place-name" title="${name}">${name}</div>
        </div>
      </div>
      <div class="time-cell">
        <time class="location-time">--:--:--</time>
        <span class="location-date">---</span>
      </div>
      <div class="zone-cell">
        <div class="zone-name" title="${timezone}">${timezone}</div>
        <span class="zone-detail">---</span>
      </div>
      <div class="coordinate-cell">
        <span class="coordinates" title="${coordinate}">${coordinate}</span>
        <button class="copy-button" type="button" data-copy="${coordinate}" aria-label="Copy coordinates for ${name}">COPY</button>
      </div>
    </article>`;
}

function render() {
  const now = new Date();
  const groups = groupedLocations(now);
  const visibleCount = groups.reduce((total, [, locations]) => total + locations.length, 0);
  const totalCount = state.data[state.activeTab].length;
  const listName = state.activeTab === "hotspots" ? "hotspots" : "timezone locations";
  elements.summary.textContent = state.query
    ? `${visibleCount} of ${totalCount} ${listName} match your search`
    : `${totalCount} ${listName} · ${groups.length} live UTC offset groups`;

  if (!visibleCount) {
    elements.groups.innerHTML = `
      <div class="empty-state">
        <strong>No locations found</strong>
        <p>Try a city, country, IANA timezone, or coordinate.</p>
      </div>`;
    state.offsetSignature = "";
    return;
  }

  elements.groups.innerHTML = groups.map(([offset, locations]) => `
    <section class="offset-group">
      <header class="group-heading">
        <span class="offset-badge">${offsetLabel(offset)}</span>
        <p>${locations.length} location${locations.length === 1 ? "" : "s"}</p>
        <p class="group-range">Grouped by current offset</p>
      </header>
      ${locations.map(rowTemplate).join("")}
    </section>`).join("");

  state.offsetSignature = groups.map(([offset, locations]) =>
    `${offset}:${locations.map((location) => location.id).join(",")}`
  ).join("|");
  updateClocks(now, false);
}

function updateClocks(now = new Date(), allowRegroup = true) {
  elements.timezoneCount.textContent = groupedLocations(now, state.data.timezones).length;
  elements.localClock.textContent = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  if (allowRegroup && state.offsetSignature) {
    const signature = groupedLocations(now).map(([offset, locations]) =>
      `${offset}:${locations.map((location) => location.id).join(",")}`
    ).join("|");
    if (signature !== state.offsetSignature) {
      render();
      return;
    }
  }

  document.querySelectorAll(".location-row").forEach((row) => {
    const timeZone = row.dataset.timezone;
    try {
      row.querySelector(".location-time").textContent = formatter(timeZone, "clock").format(now);
      row.querySelector(".location-date").textContent = formatter(timeZone, "date").format(now);
      row.querySelector(".zone-detail").textContent = `${zoneAbbreviation(timeZone, now)} · ${offsetLabel(offsetMinutes(timeZone, now))}`;
    } catch {
      row.querySelector(".zone-detail").textContent = "Timezone unavailable";
    }
  });
}

function activateTab(tabName) {
  state.activeTab = tabName;
  elements.tabs.forEach((tab) => {
    const active = tab.dataset.tab === tabName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  elements.groups.setAttribute("aria-labelledby", `tab-${tabName}`);
  render();
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 1800);
}

async function copyCoordinates(value, button) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const text = document.createElement("textarea");
    text.value = value;
    text.style.position = "fixed";
    text.style.opacity = "0";
    document.body.append(text);
    text.select();
    document.execCommand("copy");
    text.remove();
  }
  clearTimeout(copyTimers.get(button));
  button.textContent = "COPIED";
  button.classList.add("is-copied");
  button.disabled = true;
  copyTimers.set(button, setTimeout(() => {
    button.textContent = "COPY";
    button.classList.remove("is-copied");
    button.disabled = false;
    copyTimers.delete(button);
  }, 1800));
  showToast(`Copied ${value}`);
}

async function loadData() {
  try {
    const response = await fetch("./data/locations.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (
      !Array.isArray(data.hotspots) || !Array.isArray(data.timezones) ||
      !data.hotspots.every(isValidLocation) || !data.timezones.every(isValidLocation)
    ) {
      throw new Error("Invalid location data");
    }
    state.data = data;
    document.querySelector('[data-count="hotspots"]').textContent = data.hotspots.length;
    elements.timezoneCount.textContent = groupedLocations(new Date(), data.timezones).length;
    render();
  } catch (error) {
    console.error(error);
    elements.summary.textContent = "Location data could not be loaded";
    elements.groups.innerHTML = `
      <div class="error-state">
        <strong>Locations are temporarily unavailable</strong>
        <p>Please refresh the page in a moment. If this is a local preview, open it through a local web server.</p>
      </div>`;
  }
}

elements.tabs.forEach((tab) => tab.addEventListener("click", () => activateTab(tab.dataset.tab)));
elements.search.addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});
elements.groups.addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy]");
  if (button) copyCoordinates(button.dataset.copy, button);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== elements.search) {
    event.preventDefault();
    elements.search.focus();
  }
});

updateClocks();
elements.localZone.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll("_", " ");
setInterval(() => updateClocks(), 1000);
loadData();
