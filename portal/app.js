/* TTG Portal — property intelligence prototype
   All CRM state (status, notes, field overrides) persists to localStorage only.
   Master property data is a snapshot pulled from the ownership/contact sheet at build time.

   LOGIN: backed by Firebase Authentication (see firebaseConfig below). The Firebase project's
   own user list is the access-control boundary — only accounts added in the Firebase console
   can sign in. No password lives in this file. */

const firebaseConfig = {
  apiKey: "AIzaSyACrGwTCCWE01aIzvU2vWhzcRscjT8EFf0",
  authDomain: "ttg-portal-703cb.firebaseapp.com",
  projectId: "ttg-portal-703cb",
  storageBucket: "ttg-portal-703cb.firebasestorage.app",
  messagingSenderId: "756408471585",
  appId: "1:756408471585:web:14febf3d356c4a01245360"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// cosmetic only — Firebase Auth doesn't carry a display name for password accounts,
// so map known addresses to a friendlier label; anything else falls back to the local-part.
const DISPLAY_NAMES = {
  "eric@ttgrealestate.co": "Eric",
  "richie@ttglending.com": "Richie",
  "griffin@ttglending.com": "Griffin"
};
function displayNameFor(email) {
  const key = (email || "").toLowerCase();
  return DISPLAY_NAMES[key] || (key.split("@")[0] || "Associate");
}

let CURRENT_USER = null;

function friendlyAuthError(err) {
  const code = err && err.code;
  if (code === "auth/invalid-email") return "That doesn't look like a valid email.";
  if (code === "auth/user-not-found" || code === "auth/wrong-password" || code === "auth/invalid-credential") {
    return "Email or password not recognized.";
  }
  if (code === "auth/too-many-requests") return "Too many attempts — try again in a few minutes.";
  if (code === "auth/network-request-failed") return "Network error — check your connection.";
  return "Sign-in failed. Please try again.";
}

function wireLogin() {
  const form = document.getElementById("login-form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const errorEl = document.getElementById("login-error");
    const submitBtn = form.querySelector("button[type=submit]");
    errorEl.textContent = "";
    submitBtn.disabled = true;
    auth.signInWithEmailAndPassword(email, password)
      .catch((err) => { errorEl.textContent = friendlyAuthError(err); })
      .finally(() => { submitBtn.disabled = false; });
  });
}

let appStarted = false;
function startApp(user) {
  if (appStarted) return;
  appStarted = true;
  CURRENT_USER = { email: user.email, name: displayNameFor(user.email) };
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("loading").classList.remove("hidden");
  document.getElementById("associate-display").textContent = CURRENT_USER.name;
  initFilterBar();
  loadData();
}

document.addEventListener("DOMContentLoaded", () => {
  wireLogin();
  document.getElementById("logout-btn").addEventListener("click", () => {
    auth.signOut().then(() => location.reload());
  });
  auth.onAuthStateChanged((user) => {
    if (user) {
      startApp(user);
    } else if (appStarted) {
      // signed out (or session revoked) mid-session — full reload is the clean way to
      // tear down the Leaflet map/app state rather than trying to partially reset it
      location.reload();
    }
  });
});

const OVERRIDABLE_FIELDS = [
  "owner", "adjusted_owner",
  "address", "city", "zip", "year_built", "units", "sale_price", "sale_date",
  "mailing_address", "mailing_city", "mailing_state"
];
const CONTACT_COLORS = ["green", "yellow", "red"]; // cycle order; null = untagged

const FIELD_LABELS = {
  owner: "Owner (raw)",
  adjusted_owner: "Adjusted Owner",
  address: "Site Address",
  city: "City",
  zip: "Zip",
  year_built: "Year Built",
  units: "Units",
  sale_price: "Last Sale Price",
  sale_date: "Last Sale Date",
  mailing_address: "Mailing Address",
  mailing_city: "Mailing City",
  mailing_state: "Mailing State"
};

let PROPERTIES = [];        // raw master data
let CRM = {};                // { [id]: { status, notes:[], overrides:{} } }
let filtered = [];
let activeId = null;
let markerLayer = null;
let markerIndex = {};        // id -> marker
let currentView = "map";     // "map" | "calling" | "leads"
let callingScope = "all";    // "all" | "unclaimed" | "mine" — sub-filter within the Calling List view
let leadsScope = "all";      // "all" | "unclaimed" | "mine" — sub-filter within the Leads view
let trackedScope = "all";    // "all" | "unclaimed" | "mine" — sub-filter within the Tracked view
let placingPinFor = null;    // property id being repositioned, "new" for a fresh Add Property Record, or null

// ── persistence ──────────────────────────────────────────────
// CRM state (status/notes/overrides) lives in Firestore, one document per property id, gated
// by the "must be signed in" security rule. A live onSnapshot listener keeps every open session
// in sync — one associate's status change or note shows up for the others without a reload.
// loadCRM() resolves once the *first* snapshot has arrived so callers can await initial data.
function loadCRM() {
  return new Promise((resolve) => {
    let firstLoad = true;
    db.collection("crm").onSnapshot((snapshot) => {
      let activeChanged = false;
      snapshot.docChanges().forEach((change) => {
        const id = change.doc.id;
        if (change.type === "removed") {
          delete CRM[id];
        } else {
          CRM[id] = change.doc.data();
        }
        if (id === activeId) activeChanged = true;
      });

      if (firstLoad) {
        firstLoad = false;
        resolve();
        return;
      }

      // live update after initial load (our own write echoing back, or another associate's
      // change) — refresh whatever's currently on screen
      applyFilters();
      if (activeChanged) {
        const prop = PROPERTIES.find(p => p.id === activeId);
        if (prop) {
          const body = document.getElementById("drawer-body");
          body.innerHTML = drawerBodyHtml(prop, getRecord(activeId));
          wireDrawerEvents(prop);
        }
      }
    }, (err) => {
      console.error("CRM sync error:", err);
      if (firstLoad) { firstLoad = false; resolve(); }
    });
  });
}
function saveCRM(id) {
  db.collection("crm").doc(id).set(CRM[id]).catch((err) => {
    console.error("Failed to save CRM record for", id, err);
  });
}

// Properties created from scratch via "Add Property Record" live in their own collection
// (separate from the read-only chunk snapshots the migration tool writes) so the app itself
// can write to them. Live onSnapshot keeps every open session in sync, same as CRM data —
// one associate drops a pin, everyone else sees it appear without a reload.
function loadManualProperties() {
  return new Promise((resolve) => {
    let firstLoad = true;
    db.collection("manualProperties").onSnapshot((snapshot) => {
      if (firstLoad) {
        snapshot.forEach((doc) => PROPERTIES.push(doc.data()));
        firstLoad = false;
        resolve();
        return;
      }
      snapshot.docChanges().forEach((change) => {
        const data = change.doc.data();
        const idx = PROPERTIES.findIndex(p => p.id === change.doc.id);
        if (change.type === "removed") {
          if (idx >= 0) PROPERTIES.splice(idx, 1);
        } else if (idx >= 0) {
          PROPERTIES[idx] = data;
        } else {
          PROPERTIES.push(data);
        }
      });
      applyFilters();
    }, (err) => {
      console.error("manualProperties sync error:", err);
      if (firstLoad) { firstLoad = false; resolve(); }
    });
  });
}
function getRecord(id) {
  if (!CRM[id]) CRM[id] = { status: "not_contacted", notes: [], overrides: {} };
  return CRM[id];
}
function getAssociateName() {
  return CURRENT_USER ? CURRENT_USER.name : "Unassigned";
}

// ── data helpers ─────────────────────────────────────────────
function effectiveValue(prop, field) {
  const rec = CRM[prop.id];
  if (rec && rec.overrides && Object.prototype.hasOwnProperty.call(rec.overrides, field)) {
    return rec.overrides[field];
  }
  return prop[field];
}
function isOverridden(prop, field) {
  const rec = CRM[prop.id];
  return !!(rec && rec.overrides && Object.prototype.hasOwnProperty.call(rec.overrides, field));
}

// Owner contacts/phones/emails all support multiple entries plus a red/green/yellow tag per
// entry, so they're stored as [{value, color}] once an associate touches them, separately from
// the simple single-value overrides used for other fields. Master data for phones/emails is
// already an array of plain strings; owner_contact's master value is a single string (or empty),
// so it's normalized into a one-item list here too. Master values always start with color: null.
//
// Owner contact entries additionally carry a stable `id`, derived deterministically from their
// text (not random) so it survives re-renders and the master-data/override fallback switch
// without needing migration bookkeeping. Phone/email entries reference that id via `ownerId` to
// record which owner contact a given number/address belongs to.
function ownerContactId(value) {
  return "oc-" + String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function getContactEntries(prop, field) {
  const rec = CRM[prop.id];
  let entries;
  if (rec && rec.overrides && rec.overrides[field]) {
    entries = rec.overrides[field];
  } else {
    const raw = prop[field];
    entries = Array.isArray(raw) ? raw.map(v => ({ value: v, color: null })) : (raw ? [{ value: raw, color: null }] : []);
  }
  if (field === "owner_contact") {
    entries = entries.map(e => e.id ? e : { ...e, id: ownerContactId(e.value) });
  }
  return entries;
}
function setContactEntries(prop, field, entries) {
  const rec = getRecord(prop.id);
  // an empty list isn't a meaningful override — clear it rather than leaving a phantom
  // entry that would keep flagging this record as "edited" with nothing to show for it
  if (entries.length === 0) {
    delete rec.overrides[field];
  } else {
    rec.overrides[field] = entries;
  }
  saveCRM(prop.id);
  openDrawer(prop.id);
  renderList();
  renderStats();
  refreshActiveQueueView();
}
// placeholder records sourced purely from a loan have no assessor-verified unit count of
// their own — fall back to what the loan data itself reported rather than showing blank
function effectiveUnits(prop) {
  if (prop.units) return prop.units;
  const loans = prop.loans || [];
  return (loans.length && loans[0].loan_unit_count) || null;
}
function propertyType(prop) {
  const u = effectiveUnits(prop);
  if (!u || u <= 1) {
    // still no unit count anywhere — fall back to the loan's own category rather than
    // defaulting everything to Single Family
    const loans = prop.loans || [];
    if (loans.length && loans[0].loan_type === "Multifamily") return "mf";
    return "sfr";
  }
  if (u <= 4) return "small_mf";
  return "mf";
}
function propertyTypeLabel(prop) {
  const t = propertyType(prop);
  if (t === "sfr") return "Single Family";
  if (t === "small_mf") return "Small Multifamily";
  return "Multifamily";
}
function statusLabel(s) {
  return { not_contacted: "Not Contacted", needs_databasing: "Needs Databasing", ready_to_dial: "Ready to Dial", contacted: "Contacted", skip: "Skip / Not a Fit" }[s] || "Not Contacted";
}
function fmtMoney(v) {
  if (!v) return "—";
  return v;
}
function fullAddress(prop) {
  const addr = effectiveValue(prop, "address");
  const city = effectiveValue(prop, "city");
  const zip = effectiveValue(prop, "zip");
  const state = prop.state || "CO";
  return [addr, city ? city + ", " + state : "", zip].filter(Boolean).join(", ");
}

// ── loading ──────────────────────────────────────────────────
// Property/loan data lives in Firestore as a handful of "chunk" documents (one Firestore doc
// is capped at 1MB, too small for the full ~11k-record set in one piece) plus a meta/info doc
// recording how many chunks exist. See portal/migrate.html for how that data gets in.
async function loadData() {
  try {
    const metaSnap = await db.collection("meta").doc("info").get();
    if (!metaSnap.exists) throw new Error("meta/info document not found — has the data migration been run?");
    const meta = metaSnap.data();

    const chunkSnaps = await Promise.all(
      Array.from({ length: meta.chunkCount }, (_, i) => db.collection("propertyChunks").doc("chunk_" + i).get())
    );
    PROPERTIES = [];
    chunkSnaps.forEach((snap) => {
      if (snap.exists) PROPERTIES.push(...snap.data().properties);
    });

    await Promise.all([loadCRM(), loadManualProperties()]);
    populateCountyFilter();
    initMap();
    applyFilters();
    document.getElementById("loading").classList.add("hidden");
  } catch (err) {
    console.error("Failed to load data:", err);
    document.querySelector("#loading span").textContent = "Couldn't load property data — " + err.message;
  }
}

function populateCountyFilter() {
  const counties = [...new Set(PROPERTIES.map(p => p.county))].filter(Boolean).sort();
  const sel = document.getElementById("f-county");
  counties.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  });
}

// ── map ──────────────────────────────────────────────────────
// Individual small, semi-transparent dots at every zoom level (no numbered cluster
// bubbles). Dense areas naturally blend into a heatmap-like glow as dots overlap;
// preferCanvas keeps 11k+ markers fast to render and pan.
function initMap() {
  const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([39.6, -104.9], 9);

  const streetLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 20
  });
  const satelliteLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    maxZoom: 20
  });
  streetLayer.addTo(map);

  markerLayer = L.layerGroup().addTo(map);
  window.TTG_MAP = map;

  map.on("zoomend", () => restyleMarkers(map.getZoom()));
  map.on("click", (e) => {
    if (!placingPinFor) return;
    handleMapPlacementClick(e.latlng.lat, e.latlng.lng);
  });

  const BasemapToggle = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      const div = L.DomUtil.create("div", "map-layer-toggle");
      div.innerHTML = `
        <button type="button" class="layer-btn active" data-layer="street">Map</button>
        <button type="button" class="layer-btn" data-layer="satellite">Satellite</button>`;
      L.DomEvent.disableClickPropagation(div);
      div.querySelectorAll(".layer-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          if (btn.classList.contains("active")) return;
          div.querySelectorAll(".layer-btn").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          if (btn.dataset.layer === "satellite") {
            map.removeLayer(streetLayer);
            satelliteLayer.addTo(map);
          } else {
            map.removeLayer(satelliteLayer);
            streetLayer.addTo(map);
          }
        });
      });
      return div;
    }
  });
  map.addControl(new BasemapToggle());
}

function statusColor(status) {
  return { not_contacted: "#8a8f98", needs_databasing: "#c98a2c", ready_to_dial: "#3d6fb4", contacted: "#3f8f5f", skip: "#9b7fc9" }[status] || "#8a8f98";
}

// a flag (loan/property info wrong) always shows red, overriding whatever the contact status is
function markerColor(rec) {
  return rec.flagged ? "#b5482f" : statusColor(rec.status);
}

// smaller + more transparent when zoomed out so overlapping dots pool into a heat glow;
// larger + more opaque when zoomed in so individual properties are easy to click
function dotStyleForZoom(zoom) {
  if (zoom >= 15) return { radius: 6, fillOpacity: 0.9, weight: 1 };
  if (zoom >= 12) return { radius: 4.5, fillOpacity: 0.75, weight: 0.6 };
  return { radius: 3, fillOpacity: 0.6, weight: 0.6 };
}

function buildMarker(prop, style) {
  const rec = getRecord(prop.id);
  const color = markerColor(rec);
  const lat = effectiveValue(prop, "lat");
  const lon = effectiveValue(prop, "lon");
  const marker = L.circleMarker([lat, lon], {
    radius: style.radius,
    color: "#fff",
    weight: style.weight,
    fillColor: color,
    fillOpacity: style.fillOpacity
  });
  marker.bindPopup(popupHtml(prop));
  marker.on("click", () => openDrawer(prop.id));
  return marker;
}

function restyleMarkers(zoom) {
  const style = dotStyleForZoom(zoom);
  Object.entries(markerIndex).forEach(([id, m]) => {
    if (id === activeId) return; // leave the selected marker's grown style alone
    m.setStyle(style);
  });
}

// makes the selected property's dot visibly pop on the map: bigger, gold ring, full opacity, on top
let selectedMarker = null;
function applyMarkerSelection() {
  if (selectedMarker) {
    selectedMarker.setStyle(dotStyleForZoom(window.TTG_MAP ? window.TTG_MAP.getZoom() : 9));
    selectedMarker = null;
  }
  if (activeId && markerIndex[activeId]) {
    const m = markerIndex[activeId];
    m.setStyle({ radius: 12, weight: 3, color: "#b89d6a", fillOpacity: 1 });
    m.bringToFront();
    selectedMarker = m;
  }
}

function popupHtml(prop) {
  const owner = effectiveValue(prop, "adjusted_owner") || effectiveValue(prop, "owner") || "Unknown Owner";
  const place = prop.county ? prop.county + " Co." : (prop.state || "");
  return `<b>${escapeHtml(owner)}</b><br>${escapeHtml(fullAddress(prop))}<br><span style="color:#8a8f98">${propertyTypeLabel(prop)} · ${effectiveUnits(prop) || "?"} units · ${escapeHtml(place)}</span>`;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── filtering ────────────────────────────────────────────────
function currentFilters() {
  return {
    search: document.getElementById("f-search").value.trim().toLowerCase(),
    state: document.getElementById("f-state").value,
    county: document.getElementById("f-county").value,
    type: document.getElementById("f-type").value,
    status: document.getElementById("f-status").value,
    loanCategory: document.getElementById("f-loan-category").value,
    hasContact: document.getElementById("f-has-contact").checked,
    overriddenOnly: document.getElementById("f-overridden").checked,
    flaggedOnly: document.getElementById("f-flagged").checked,
    maturityFrom: document.getElementById("f-maturity-from").value,
    maturityTo: document.getElementById("f-maturity-to").value
  };
}

function matchesFilters(prop, f) {
  if (f.state && (prop.state || "CO") !== f.state) return false;
  if (f.county && prop.county !== f.county) return false;
  if (f.type && propertyType(prop) !== f.type) return false;
  const rec = getRecord(prop.id);
  if (f.status && rec.status !== f.status) return false;
  if (f.overriddenOnly && (!rec.overrides || Object.keys(rec.overrides).length === 0)) return false;
  if (f.flaggedOnly && !rec.flagged) return false;
  if (f.loanCategory) {
    const loans = prop.loans || [];
    if (!loans.length || loans[0].loan_type !== f.loanCategory) return false;
  }
  if (f.hasContact) {
    const phones = effectiveValue(prop, "phones") || [];
    const emails = effectiveValue(prop, "emails") || [];
    if (phones.length === 0 && emails.length === 0) return false;
  }
  if (f.maturityFrom || f.maturityTo) {
    const loans = prop.loans || [];
    const maturity = loans.length ? loans[0].maturity_date : null;
    if (!maturity) return false;
    if (f.maturityFrom && maturity < f.maturityFrom) return false;
    if (f.maturityTo && maturity > f.maturityTo) return false;
  }
  if (f.search) {
    const owner = (effectiveValue(prop, "adjusted_owner") || effectiveValue(prop, "owner") || "").toLowerCase();
    const addr = (effectiveValue(prop, "address") || "").toLowerCase();
    const apn = (prop.apn || "").toLowerCase();
    if (!owner.includes(f.search) && !addr.includes(f.search) && !apn.includes(f.search)) return false;
  }
  return true;
}

function applyFilters() {
  const f = currentFilters();
  filtered = PROPERTIES.filter(p => matchesFilters(p, f));
  renderList();
  renderMarkers();
  renderStats();
  document.getElementById("filter-count-n").textContent = filtered.length.toLocaleString();
  refreshActiveQueueView();
}

// ── list rendering ───────────────────────────────────────────
function renderList() {
  const pane = document.getElementById("listpane");
  if (filtered.length === 0) {
    pane.innerHTML = `<div class="empty-state">No properties match these filters.<br>Try widening your search.</div>`;
    return;
  }
  // cap rendered rows for perf; map still reflects full filtered set
  const rows = filtered.slice(0, 400);
  pane.innerHTML = rows.map(rowHtml).join("") +
    (filtered.length > 400 ? `<div class="empty-state">Showing first 400 of ${filtered.length.toLocaleString()} — narrow your filters to see more in the list (map shows all).</div>` : "");

  pane.querySelectorAll(".prop-row").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      openDrawer(id);
      const m = markerIndex[id];
      if (m && window.TTG_MAP) window.TTG_MAP.setView(m.getLatLng(), Math.max(window.TTG_MAP.getZoom(), 15));
    });
  });
}

function rowHtml(prop) {
  const rec = getRecord(prop.id);
  const owner = effectiveValue(prop, "adjusted_owner") || effectiveValue(prop, "owner") || "Unknown Owner";
  const addr = fullAddress(prop);
  const overridden = rec.overrides && Object.keys(rec.overrides).length > 0;
  const place = prop.county ? prop.county + " Co." : (prop.state || "");
  return `
  <div class="prop-row${prop.id === activeId ? " active" : ""}" data-id="${escapeHtml(prop.id)}">
    <div class="prop-row-top">
      <div class="status-dot ${rec.flagged ? "status-flagged" : "status-" + rec.status}"></div>
      <div style="flex:1">
        <div class="prop-addr">${escapeHtml(addr || "Address unknown")}</div>
        <div class="prop-sub">${escapeHtml(owner)}</div>
        <div class="prop-meta">
          <span>${propertyTypeLabel(prop)}</span>
          <span>${effectiveUnits(prop) || "?"} units</span>
          <span>${escapeHtml(place)}</span>
          ${rec.flagged ? '<span class="tag tag-flagged">Flagged</span>' : ""}
          ${rec.isLead ? '<span class="tag tag-lead">Lead</span>' : ""}
          ${rec.isTracked ? '<span class="tag tag-tracked">Tracked</span>' : ""}
          ${prop.is_placeholder ? '<span class="tag tag-placeholder">Needs Property Info</span>' : ""}
          ${overridden ? '<span class="tag">Edited</span>' : ""}
          ${loanTagHtml(prop)}
        </div>
      </div>
    </div>
  </div>`;
}

function renderMarkers() {
  markerLayer.clearLayers();
  markerIndex = {};
  selectedMarker = null;
  const style = dotStyleForZoom(window.TTG_MAP ? window.TTG_MAP.getZoom() : 9);
  filtered.forEach(p => {
    const lat = effectiveValue(p, "lat");
    const lon = effectiveValue(p, "lon");
    if (lat == null || lon == null) return;
    const m = buildMarker(p, style);
    markerIndex[p.id] = m;
    markerLayer.addLayer(m);
  });
  applyMarkerSelection();
}

function renderStats() {
  document.getElementById("stat-total").textContent = PROPERTIES.length.toLocaleString();
  let contacted = 0, needs = 0, overridden = 0, flagged = 0;
  PROPERTIES.forEach(p => {
    const rec = CRM[p.id];
    if (rec) {
      if (rec.status === "contacted") contacted++;
      if (rec.status === "needs_databasing") needs++;
      if (rec.overrides && Object.keys(rec.overrides).length > 0) overridden++;
      if (rec.flagged) flagged++;
    }
  });
  document.getElementById("stat-contacted").textContent = contacted.toLocaleString();
  document.getElementById("stat-needs").textContent = needs.toLocaleString();
  document.getElementById("stat-overrides").textContent = overridden.toLocaleString();
  document.getElementById("stat-flagged").textContent = flagged.toLocaleString();

  const readyToDial = PROPERTIES.reduce((n, p) => n + (getRecord(p.id).status === "ready_to_dial" ? 1 : 0), 0);
  document.getElementById("calling-badge").textContent = readyToDial.toLocaleString();

  const leadsCount = PROPERTIES.reduce((n, p) => n + (getRecord(p.id).isLead ? 1 : 0), 0);
  document.getElementById("leads-badge").textContent = leadsCount.toLocaleString();

  const trackedCount = PROPERTIES.reduce((n, p) => n + (getRecord(p.id).isTracked ? 1 : 0), 0);
  document.getElementById("tracked-badge").textContent = trackedCount.toLocaleString();
}

// ── calling list / leads views ──────────────────────────────────
// Databasers mark a property "Ready to Dial" once research is done but no one has called yet;
// the Calling List turns that into an actual worklist associates can claim rows from and dial
// down. Leads works the same way but banks properties from a positive conversation instead —
// same table shape, same claim mechanism, different membership test (isLead vs. status).
function switchView(view) {
  currentView = view;
  document.querySelectorAll(".view-tab").forEach(t => t.classList.toggle("active", t.dataset.view === view));
  document.getElementById("main").classList.toggle("hidden", view !== "map");
  document.getElementById("calling-list-view").classList.toggle("visible", view === "calling");
  document.getElementById("leads-view").classList.toggle("visible", view === "leads");
  document.getElementById("tracked-view").classList.toggle("visible", view === "tracked");
  if (view === "map" && window.TTG_MAP) {
    // the map's container was display:none — Leaflet needs a nudge to redraw correctly
    setTimeout(() => window.TTG_MAP.invalidateSize(), 50);
  }
  refreshActiveQueueView();
}

function refreshActiveQueueView() {
  if (currentView === "calling") renderCallingList();
  if (currentView === "leads") renderLeadsList();
  if (currentView === "tracked") renderTrackedList();
}

// Switches to Map View, opens the property's drawer, and pans/zooms to its marker — used from
// the Calling List / Leads / Tracked tables where the map isn't currently on screen.
function viewPropertyOnMap(id) {
  switchView("map");
  openDrawer(id);
  setTimeout(() => {
    const m = markerIndex[id];
    if (m && window.TTG_MAP) {
      window.TTG_MAP.setView(m.getLatLng(), Math.max(window.TTG_MAP.getZoom(), 15));
    }
  }, 60); // just after switchView's own invalidateSize timeout so the pan lands correctly
}

// ── pin placement (move an existing pin, or drop a brand new one) ──────────
// Both flows work the same way: arm placement mode, switch to the map, and wait for the
// next click on the map background. Repositioning an existing property goes through the
// normal lat/lon override (revertable, synced via the CRM doc); a brand new property is
// created outright in its own Firestore collection since there's no master record to override.
function startPinPlacement(id) {
  placingPinFor = id;
  switchView("map");
  document.getElementById("pin-placement-text").textContent = id === "new"
    ? "Click anywhere on the map to place the new property's pin."
    : "Click anywhere on the map to move this property's pin.";
  document.getElementById("pin-placement-hint").classList.add("visible");
  if (window.TTG_MAP) window.TTG_MAP.getContainer().style.cursor = "crosshair";
}

function cancelPinPlacement() {
  placingPinFor = null;
  document.getElementById("pin-placement-hint").classList.remove("visible");
  if (window.TTG_MAP) window.TTG_MAP.getContainer().style.cursor = "";
}

function handleMapPlacementClick(lat, lon) {
  const target = placingPinFor;
  cancelPinPlacement();
  if (target === "new") {
    createManualProperty(lat, lon);
  } else if (target) {
    const rec = getRecord(target);
    rec.overrides.lat = lat;
    rec.overrides.lon = lon;
    saveCRM(target);
    renderMarkers();
    renderList();
    renderStats();
    if (activeId === target) openDrawer(target);
    refreshActiveQueueView();
  }
}

function createManualProperty(lat, lon) {
  const id = "manual-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const state = document.getElementById("f-state").value || "CO";
  const newProp = {
    id, county: "", state,
    apn: "", owner: "", adjusted_owner: "", owner_contact: "", first_name: "",
    phones: [], emails: [],
    address: "", city: "", zip: "",
    year_built: "", units: null, units_raw: "",
    sale_price: "", sale_date: "",
    mailing_address: "", mailing_city: "", mailing_state: "",
    monday_uploaded: "",
    loans: [],
    is_placeholder: true,
    is_manual: true,
    lat, lon
  };
  PROPERTIES.push(newProp);
  db.collection("manualProperties").doc(id).set(newProp).catch((err) => {
    console.error("Failed to save new property record:", err);
  });
  applyFilters();
  openDrawer(id);
}

function ownerFirstName(prop) {
  if (prop.first_name) return prop.first_name;
  const name = effectiveValue(prop, "adjusted_owner") || effectiveValue(prop, "owner") || "";
  return name.trim().split(/\s+/)[0] || "";
}

function renderCallingList() {
  renderQueueTable({
    wrapId: "calling-table-wrap",
    tbodyId: "calling-tbody",
    countId: "calling-count-n",
    scope: callingScope,
    props: filtered.filter(p => getRecord(p.id).status === "ready_to_dial"),
    emptyMessage: `No properties in this queue.<br>Mark properties "Ready to Dial" from their detail panel to add them here.`
  });
}

function renderLeadsList() {
  renderQueueTable({
    wrapId: "leads-table-wrap",
    tbodyId: "leads-tbody",
    countId: "leads-count-n",
    scope: leadsScope,
    props: filtered.filter(p => getRecord(p.id).isLead),
    emptyMessage: `No leads banked yet.<br>Mark a property "Lead" from its detail panel after a positive conversation to add it here.`
  });
}

function renderTrackedList() {
  renderQueueTable({
    wrapId: "tracked-table-wrap",
    tbodyId: "tracked-tbody",
    countId: "tracked-count-n",
    scope: trackedScope,
    props: filtered.filter(p => getRecord(p.id).isTracked),
    emptyMessage: `Nothing tracked yet.<br>Mark a property "Track" from its detail panel to keep an eye on it here — no need for it to be a lead.`
  });
}

// shared table renderer for the Calling List and Leads views — same columns, same claim
// mechanism, different membership test (passed in via `props`)
function renderQueueTable({ wrapId, tbodyId, countId, scope, props, emptyMessage }) {
  const wrap = document.getElementById(wrapId);
  wrap.innerHTML = `
    <table class="queue-table">
      <thead>
        <tr><th>Claim</th><th>Address</th><th>Units</th><th>Owner First Name</th><th>Phone Numbers</th><th>Emails</th></tr>
      </thead>
      <tbody id="${tbodyId}"></tbody>
    </table>`;

  let scoped = props;
  if (scope === "unclaimed") {
    scoped = props.filter(p => !getRecord(p.id).claimed_by);
  } else if (scope === "mine") {
    const me = CURRENT_USER && CURRENT_USER.email;
    scoped = props.filter(p => getRecord(p.id).claimed_by === me);
  }

  document.getElementById(countId).textContent = scoped.length.toLocaleString();

  if (scoped.length === 0) {
    wrap.innerHTML = `<div class="calling-empty">${emptyMessage}</div>`;
    return;
  }

  const body = document.getElementById(tbodyId);
  body.innerHTML = scoped.map(callingRowHtml).join("");
  body.querySelectorAll("tr[data-id]").forEach(tr => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-claim],[data-release],[data-view-map]")) return;
      openDrawer(tr.dataset.id);
    });
  });
  body.querySelectorAll("[data-claim]").forEach(el => {
    el.addEventListener("click", (e) => { e.stopPropagation(); claimProperty(el.dataset.claim); });
  });
  body.querySelectorAll("[data-release]").forEach(el => {
    el.addEventListener("click", (e) => { e.stopPropagation(); releaseProperty(el.dataset.release); });
  });
  body.querySelectorAll("[data-view-map]").forEach(el => {
    el.addEventListener("click", (e) => { e.stopPropagation(); viewPropertyOnMap(el.dataset.viewMap); });
  });
}

function callingRowHtml(prop) {
  const rec = getRecord(prop.id);
  const phones = getContactEntries(prop, "phones").map(e => e.value).join(", ") || "—";
  const emails = getContactEntries(prop, "emails").map(e => e.value).join(", ") || "—";
  const addr = fullAddress(prop);
  const place = prop.county ? prop.county + " Co." : (prop.state || "");
  const me = CURRENT_USER && CURRENT_USER.email;

  let claimCell;
  if (!rec.claimed_by) {
    claimCell = `<button class="claim-btn" data-claim="${escapeHtml(prop.id)}" type="button">Claim</button>`;
  } else if (rec.claimed_by === me) {
    claimCell = `<span class="claimed-mine">Claimed by you</span><span class="release-link" data-release="${escapeHtml(prop.id)}">Release</span>`;
  } else {
    claimCell = `<span class="claimed-other">${escapeHtml(rec.claimed_by_name || rec.claimed_by)}</span><span class="release-link" data-release="${escapeHtml(prop.id)}">Release</span>`;
  }

  return `
  <tr data-id="${escapeHtml(prop.id)}" class="${prop.id === activeId ? "active" : ""}">
    <td>${claimCell}</td>
    <td>
      <div class="calling-addr">${escapeHtml(addr || "Address unknown")}</div>
      <div class="calling-sub">${escapeHtml(place)}</div>
      <button class="view-map-btn" data-view-map="${escapeHtml(prop.id)}" type="button">View on Map</button>
    </td>
    <td>${effectiveUnits(prop) || "—"}</td>
    <td>${escapeHtml(ownerFirstName(prop)) || "—"}</td>
    <td>${escapeHtml(phones)}</td>
    <td>${escapeHtml(emails)}</td>
  </tr>`;
}

function claimProperty(id) {
  const rec = getRecord(id);
  rec.claimed_by = CURRENT_USER ? CURRENT_USER.email : null;
  rec.claimed_by_name = CURRENT_USER ? CURRENT_USER.name : null;
  rec.claimed_at = Date.now();
  saveCRM(id);
  refreshActiveQueueView();
}

function releaseProperty(id) {
  const rec = getRecord(id);
  delete rec.claimed_by;
  delete rec.claimed_by_name;
  delete rec.claimed_at;
  saveCRM(id);
  refreshActiveQueueView();
}

// ── drawer / CRM detail ──────────────────────────────────────
function openDrawer(id) {
  activeId = id;
  const prop = PROPERTIES.find(p => p.id === id);
  if (!prop) return;
  const rec = getRecord(id);

  document.getElementById("d-addr").textContent = fullAddress(prop) || "Address unknown";
  const subParts = [];
  if (prop.county) subParts.push(prop.county + " County, " + (prop.state || "CO"));
  else subParts.push(prop.state || "CO");
  subParts.push("APN " + (prop.apn || "—"));
  subParts.push(propertyTypeLabel(prop));
  document.getElementById("d-sub").textContent = subParts.join(" · ");

  const wasOpen = document.getElementById("drawer").classList.contains("open");
  const body = document.getElementById("drawer-body");
  body.innerHTML = drawerBodyHtml(prop, rec);
  wireDrawerEvents(prop);
  if (!wasOpen) body.scrollTop = 0;

  document.getElementById("drawer").classList.add("open");
  document.getElementById("overlay").classList.add("open");
  renderList(); // to reflect active highlight
  applyMarkerSelection();
}

function closeDrawer() {
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("overlay").classList.remove("open");
  activeId = null;
  renderList();
  applyMarkerSelection();
}

function editableField(prop, field) {
  const val = effectiveValue(prop, field);
  const display = val || "—";
  const overridden = isOverridden(prop, field);
  return `
  <div class="d-field" data-field="${field}">
    <div class="k">${FIELD_LABELS[field]}</div>
    <div class="v-wrap" style="flex:1;text-align:right;">
      <span class="v-display${overridden ? " overridden" : ""}" title="${overridden ? "Edited — differs from the master data set" : ""}">${escapeHtml(display)}<span class="edit-pencil" data-edit="${field}">&#9998;</span></span>
      ${overridden ? `<span class="field-revert" data-revert="${field}">Revert</span>` : ""}
    </div>
  </div>`;
}

function contactEntryHtml(prop, field, entry, idx) {
  const dotClass = entry.color ? `dot-${entry.color}` : "dot-none";
  const valClass = entry.color ? `tagged-${entry.color}` : "";
  // only phones/emails are meaningfully clickable (tel:/mailto:); owner contact names are plain text
  const valueHtml = field === "phones"
    ? `<a href="tel:${encodeURIComponent(entry.value)}" class="contact-value ${valClass}">${escapeHtml(entry.value)}</a>`
    : field === "emails"
      ? `<a href="mailto:${encodeURIComponent(entry.value)}" class="contact-value ${valClass}">${escapeHtml(entry.value)}</a>`
      : `<span class="contact-value ${valClass}">${escapeHtml(entry.value)}</span>`;

  // phones/emails can be pinned to a specific owner contact so associates know whose number they're calling
  let ownerSelectHtml = "";
  if (field === "phones" || field === "emails") {
    const owners = getContactEntries(prop, "owner_contact");
    const options = [`<option value="">Unassigned</option>`].concat(
      owners.map(o => `<option value="${escapeHtml(o.id)}"${entry.ownerId === o.id ? " selected" : ""}>${escapeHtml(o.value)}</option>`)
    );
    ownerSelectHtml = `<select class="owner-assign-select" data-field="${field}" data-idx="${idx}" title="Which owner contact does this belong to?">${options.join("")}</select>`;
  }

  return `
  <div class="contact-entry" data-field="${field}" data-idx="${idx}">
    <span class="color-dot ${dotClass}" data-cycle-color title="Click to tag: none → green → yellow → red"></span>
    ${valueHtml}
    ${ownerSelectHtml}
    <span class="contact-remove" data-remove-entry title="Remove">&times;</span>
  </div>`;
}

function contactGroupHtml(prop, field, label, placeholder) {
  const entries = getContactEntries(prop, field);
  return `
  <div class="contact-group">
    <div class="contact-group-label">${label}</div>
    <div class="contact-entries">
      ${entries.length ? entries.map((e, i) => contactEntryHtml(prop, field, e, i)).join("") : `<div class="contact-empty">None on file</div>`}
    </div>
    <div class="contact-add-row">
      <input type="text" class="contact-add-input" data-add-field="${field}" placeholder="${placeholder}" />
      <button class="contact-add-btn" data-add-field="${field}" type="button">Add</button>
    </div>
  </div>`;
}

function drawerBodyHtml(prop, rec) {
  const contactOverridden = isOverridden(prop, "owner_contact") || isOverridden(prop, "phones") || isOverridden(prop, "emails");
  const hasAnyOverride = !!(rec.overrides && Object.keys(rec.overrides).length > 0);

  return `
  ${prop.is_placeholder ? `
  <div class="placeholder-banner">
    <strong>No property record yet</strong> — this entry was created from a loan record with no matching
    assessor data. Fill in ownership, contact, and property details below as you research it.
  </div>` : ""}

  ${hasAnyOverride ? `
  <div class="placeholder-banner">
    <strong>Edited</strong> — one or more fields on this record have been changed and differ from the master data set.
  </div>` : ""}

  <div class="d-section">
    <h4>CRM Status</h4>
    <div class="status-buttons">
      <button class="status-btn${rec.status === "not_contacted" ? " active" : ""}" data-status="not_contacted">Not Contacted</button>
      <button class="status-btn${rec.status === "needs_databasing" ? " active" : ""}" data-status="needs_databasing">Needs Databasing</button>
      <button class="status-btn${rec.status === "ready_to_dial" ? " active" : ""}" data-status="ready_to_dial">Ready to Dial</button>
      <button class="status-btn${rec.status === "contacted" ? " active" : ""}" data-status="contacted">Contacted</button>
      <button class="status-btn status-btn-wide${rec.status === "skip" ? " active" : ""}" data-status="skip">Skip — Institutional / Bad Lead</button>
    </div>
    <div class="marker-buttons">
      <button class="flag-btn${rec.flagged ? " active" : ""}" id="flag-toggle" type="button">
        ${rec.flagged ? "⚑ Flagged — Info Incorrect" : "⚑ Flag Info as Incorrect"}
      </button>
      <button class="lead-btn${rec.isLead ? " active" : ""}" id="lead-toggle" type="button">
        ${rec.isLead ? "★ Lead — Positive Conversation" : "★ Mark as Lead"}
      </button>
      <button class="track-btn${rec.isTracked ? " active" : ""}" id="track-toggle" type="button">
        ${rec.isTracked ? "&#128065; Tracking This Property" : "&#128065; Track This Property"}
      </button>
    </div>
    ${rec.claimed_by ? `
    <div class="claimed-note">
      <span>Claimed by ${rec.claimed_by === (CURRENT_USER && CURRENT_USER.email) ? "you" : escapeHtml(rec.claimed_by_name || rec.claimed_by)}</span>
      <span class="release-link" data-release="${escapeHtml(prop.id)}">Release</span>
    </div>` : ""}
  </div>

  <div class="d-section">
    <h4>Call Notes</h4>
    <div class="notes-list" id="notes-list">
      ${rec.notes.length === 0 ? '<div style="color:#8a8f98;font-size:11.5px;">No notes yet.</div>' :
        rec.notes.slice().reverse().map(n => `
          <div class="note-item">
            <div class="note-meta">${escapeHtml(n.author)} · ${new Date(n.ts).toLocaleString()}</div>
            <div>${escapeHtml(n.text)}</div>
          </div>`).join("")}
    </div>
    <div class="note-form">
      <textarea id="note-input" placeholder="Log a call or note…"></textarea>
      <button id="note-save">Add</button>
    </div>
  </div>

  <div class="d-section">
    <h4>Property</h4>
    <button class="pin-edit-btn" id="pin-edit-toggle" type="button">&#128205; Edit Pin Location</button>
    ${editableField(prop, "address")}
    ${editableField(prop, "city")}
    ${editableField(prop, "zip")}
    ${editableField(prop, "year_built")}
    ${editableField(prop, "units")}
    ${editableField(prop, "sale_price")}
    ${editableField(prop, "sale_date")}
  </div>

  <div class="d-section">
    <h4>Ownership</h4>
    ${editableField(prop, "owner")}
    ${editableField(prop, "adjusted_owner")}
    ${editableField(prop, "mailing_address")}
    ${editableField(prop, "mailing_city")}
    ${editableField(prop, "mailing_state")}
  </div>

  <div class="d-section">
    <div class="d-section-head">
      <h4>Contact Info</h4>
      ${contactOverridden ? `<span class="field-revert" data-revert-contact="1">Revert edits</span>` : ""}
    </div>
    ${contactGroupHtml(prop, "owner_contact", "Owner Contacts", "Add contact name…")}
    ${contactGroupHtml(prop, "phones", "Phone Numbers", "Add phone…")}
    ${contactGroupHtml(prop, "emails", "Emails", "Add email…")}
  </div>

  <div class="d-section">
    <h4>Loan Maturity</h4>
    ${loanSectionHtml(prop)}
  </div>
  `;
}

const STATE_SHEET_NAMES = { CO: "Colorado", AZ: "Arizona", TX: "Texas" };

function fmtLoanNum(v) {
  if (v === null || v === undefined || v === "") return "—";
  return typeof v === "number" ? v.toLocaleString() : v;
}

function loanSectionHtml(prop) {
  const loans = prop.loans || [];
  if (loans.length === 0) {
    return `<div class="loan-placeholder">No loan record matched this address in the loan data.</div>`;
  }
  const current = loans[0];
  const history = loans.slice(1);
  const sheetName = STATE_SHEET_NAMES[prop.state] || prop.state || "";
  const interestRate = current.interest_rate
    ? current.interest_rate + (current.interest_rate_type ? ` (${escapeHtml(current.interest_rate_type)})` : "")
    : "—";
  return `
    <div class="loan-caption">Matched by property address from the ${sheetName}&nbsp;-&nbsp;Loans sheet${loans.length > 1 ? ` · ${loans.length} loans on file, most recent shown first` : ""}.</div>
    <div class="loan-current">
      <div class="loan-row"><span class="k">Loan Category</span><span class="v">${escapeHtml(current.loan_type || "—")}</span></div>
      <div class="loan-row"><span class="k">Lender</span><span class="v">${escapeHtml(current.lender || "—")}</span></div>
      <div class="loan-row"><span class="k">Borrower</span><span class="v">${escapeHtml(current.borrower || "—")}</span></div>
      <div class="loan-row"><span class="k">Loan Amount</span><span class="v">${escapeHtml(current.mortgage_amount || "—")}</span></div>
      <div class="loan-row"><span class="k">Sale Amount</span><span class="v">${escapeHtml(current.sale_amount || "—")}</span></div>
      <div class="loan-row"><span class="k">Estimated LTV</span><span class="v">${escapeHtml(current.estimated_ltv || "—")}</span></div>
      <div class="loan-row"><span class="k">Interest Rate</span><span class="v">${interestRate}</span></div>
      <div class="loan-row"><span class="k">Term</span><span class="v">${current.term_months ? escapeHtml(current.term_months + " mo") : "—"}</span></div>
      <div class="loan-row"><span class="k">Origination</span><span class="v">${escapeHtml(current.origination_date || "—")}</span></div>
      <div class="loan-row"><span class="k">Maturity</span><span class="v loan-maturity-val">${escapeHtml(current.maturity_date || "—")}</span></div>
      <div class="loan-row"><span class="k">Estimated Maturity</span><span class="v">${escapeHtml(current.estimated_maturity_date || "—")}</span></div>
      <div class="loan-row"><span class="k">Due Date</span><span class="v">${escapeHtml(current.due_date || "—")}</span></div>
      <div class="loan-row"><span class="k">Estimated Due Date</span><span class="v">${escapeHtml(current.estimated_due_date || "—")}</span></div>
      <div class="loan-row"><span class="k">Lender Type</span><span class="v">${escapeHtml(current.lender_type || "—")}</span></div>
      <div class="loan-row"><span class="k">Transaction Type</span><span class="v">${escapeHtml(current.property_type || "—")}</span></div>
      <div class="loan-row"><span class="k">Year Built (per loan)</span><span class="v">${fmtLoanNum(current.loan_year_built)}</span></div>
      <div class="loan-row"><span class="k">Units (per loan)</span><span class="v">${fmtLoanNum(current.loan_unit_count)}</span></div>
      <div class="loan-row"><span class="k">Building Sq Ft</span><span class="v">${fmtLoanNum(current.building_sqft)}</span></div>
    </div>
    ${history.length ? `
    <div class="loan-history">
      <div class="loan-history-label">Prior Loans (${history.length})</div>
      ${history.map(l => `
        <div class="loan-history-item">
          <span>${escapeHtml(l.origination_date || "?")} &rarr; ${escapeHtml(l.maturity_date || "?")}</span>
          <span>${escapeHtml(l.lender || "—")}</span>
          <span>${escapeHtml(l.mortgage_amount || "—")}</span>
        </div>`).join("")}
    </div>` : ""}
  `;
}

// nearest-maturity tag shown on list rows so upcoming maturities are visible without opening each property
function loanTagHtml(prop) {
  const loans = prop.loans || [];
  if (loans.length === 0 || !loans[0].maturity_date) return "";
  const maturity = loans[0].maturity_date;
  const d = new Date(maturity);
  if (isNaN(d.getTime())) return "";
  const monthsOut = (d - new Date()) / (1000 * 60 * 60 * 24 * 30);
  const urgent = monthsOut <= 12;
  const label = d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  return `<span class="tag${urgent ? " tag-urgent" : ""}" title="Nearest loan maturity on file">Loan due ${label}</span>`;
}

function wireDrawerEvents(prop) {
  const rec = getRecord(prop.id);

  document.querySelectorAll(".status-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      rec.status = btn.dataset.status;
      saveCRM(prop.id);
      openDrawer(prop.id);
      renderList();
      renderMarkers();
      renderStats();
      refreshActiveQueueView();
    });
  });

  document.getElementById("flag-toggle").addEventListener("click", () => {
    rec.flagged = !rec.flagged;
    saveCRM(prop.id);
    openDrawer(prop.id);
    renderMarkers();
    renderList();
    renderStats();
  });

  document.getElementById("pin-edit-toggle").addEventListener("click", () => startPinPlacement(prop.id));

  document.getElementById("lead-toggle").addEventListener("click", () => {
    rec.isLead = !rec.isLead;
    saveCRM(prop.id);
    openDrawer(prop.id);
    renderList();
    renderStats();
    refreshActiveQueueView();
  });

  document.getElementById("track-toggle").addEventListener("click", () => {
    rec.isTracked = !rec.isTracked;
    saveCRM(prop.id);
    openDrawer(prop.id);
    renderList();
    renderStats();
    refreshActiveQueueView();
  });

  const drawerReleaseLink = document.querySelector(".claimed-note [data-release]");
  if (drawerReleaseLink) {
    drawerReleaseLink.addEventListener("click", () => {
      releaseProperty(prop.id);
      openDrawer(prop.id);
    });
  }

  document.getElementById("note-save").addEventListener("click", () => {
    const input = document.getElementById("note-input");
    const text = input.value.trim();
    if (!text) return;
    rec.notes.push({ text, author: getAssociateName(), ts: Date.now() });
    saveCRM(prop.id);
    openDrawer(prop.id);
  });

  document.querySelectorAll("[data-edit]").forEach(el => {
    el.addEventListener("click", () => startEdit(prop, el.dataset.edit));
  });
  document.querySelectorAll("[data-revert]").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      delete rec.overrides[el.dataset.revert];
      saveCRM(prop.id);
      openDrawer(prop.id);
      renderList();
      renderStats();
      refreshActiveQueueView();
    });
  });

  // contact entries: add / remove / cycle color tag
  document.querySelectorAll(".contact-add-btn").forEach(btn => {
    btn.addEventListener("click", () => addContactEntry(prop, btn.dataset.addField));
  });
  document.querySelectorAll(".contact-add-input").forEach(input => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addContactEntry(prop, input.dataset.addField); }
    });
  });
  document.querySelectorAll("[data-cycle-color]").forEach(el => {
    el.addEventListener("click", () => cycleContactColor(prop, el.closest(".contact-entry")));
  });
  document.querySelectorAll("[data-remove-entry]").forEach(el => {
    el.addEventListener("click", () => removeContactEntry(prop, el.closest(".contact-entry")));
  });
  document.querySelectorAll(".owner-assign-select").forEach(sel => {
    sel.addEventListener("change", () => {
      const field = sel.dataset.field;
      const idx = parseInt(sel.dataset.idx, 10);
      const entries = getContactEntries(prop, field).map(e => ({ ...e }));
      entries[idx].ownerId = sel.value || null;
      setContactEntries(prop, field, entries);
    });
  });
  document.querySelectorAll("[data-revert-contact]").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      delete rec.overrides.owner_contact;
      delete rec.overrides.phones;
      delete rec.overrides.emails;
      saveCRM(prop.id);
      openDrawer(prop.id);
      renderList();
      renderStats();
      refreshActiveQueueView();
    });
  });
}

function addContactEntry(prop, field) {
  const input = document.querySelector(`.contact-add-input[data-add-field="${field}"]`);
  const val = input.value.trim();
  if (!val) return;
  const entries = getContactEntries(prop, field).slice();
  const newEntry = { value: val, color: null };
  if (field === "owner_contact") newEntry.id = ownerContactId(val);
  entries.push(newEntry);
  setContactEntries(prop, field, entries);
}

function removeContactEntry(prop, entryEl) {
  const field = entryEl.dataset.field;
  const idx = parseInt(entryEl.dataset.idx, 10);
  const entries = getContactEntries(prop, field).slice();
  entries.splice(idx, 1);
  setContactEntries(prop, field, entries);
}

function cycleContactColor(prop, entryEl) {
  const field = entryEl.dataset.field;
  const idx = parseInt(entryEl.dataset.idx, 10);
  const entries = getContactEntries(prop, field).map(e => ({ ...e }));
  const order = [null, ...CONTACT_COLORS];
  const next = order[(order.indexOf(entries[idx].color) + 1) % order.length];
  entries[idx].color = next;
  setContactEntries(prop, field, entries);
}

function startEdit(prop, field) {
  const rec = getRecord(prop.id);
  const wrap = document.querySelector(`.d-field[data-field="${field}"] .v-wrap`);
  const currentStr = effectiveValue(prop, field) || "";

  wrap.innerHTML = `<input type="text" id="edit-input" value="${escapeHtml(currentStr)}" />`;
  const input = document.getElementById("edit-input");
  input.focus();
  input.select();

  function commit() {
    const newVal = input.value.trim();
    const originalVal = prop[field];
    const originalStr = originalVal || "";

    if (newVal === originalStr || newVal === "") {
      delete rec.overrides[field];
    } else {
      rec.overrides[field] = newVal;
    }
    saveCRM(prop.id);
    openDrawer(prop.id);
    renderList();
    renderMarkers();
    renderStats();
    refreshActiveQueueView();
  }

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.value = currentStr; input.blur(); }
  });
}

function clearMaturityPresetActive() {
  document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
}

// ── wiring ───────────────────────────────────────────────────
function initFilterBar() {
  ["f-search", "f-state", "f-county", "f-type", "f-status", "f-loan-category", "f-has-contact", "f-overridden", "f-flagged", "f-maturity-from", "f-maturity-to"].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener(el.tagName === "INPUT" && el.type === "text" ? "input" : "change", () => {
      clearMaturityPresetActive();
      applyFilters();
    });
  });
  document.getElementById("f-state").addEventListener("change", (e) => {
    const views = { CO: [[39.6, -104.9], 9], AZ: [[33.6, -111.9], 7], TX: [[31.4, -99.3], 6] };
    const view = views[e.target.value];
    if (view && window.TTG_MAP) window.TTG_MAP.setView(view[0], view[1]);
  });
  document.querySelectorAll(".preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      // clicking an already-active preset toggles it off and clears the maturity filter,
      // instead of needing "Clear filters" just to undo this one control
      if (btn.classList.contains("active")) {
        document.getElementById("f-maturity-from").value = "";
        document.getElementById("f-maturity-to").value = "";
        clearMaturityPresetActive();
        applyFilters();
        return;
      }
      const months = parseInt(btn.dataset.months, 10);
      const from = new Date();
      const to = new Date();
      to.setMonth(to.getMonth() + months);
      document.getElementById("f-maturity-from").value = from.toISOString().slice(0, 10);
      document.getElementById("f-maturity-to").value = to.toISOString().slice(0, 10);
      clearMaturityPresetActive();
      btn.classList.add("active");
      applyFilters();
    });
  });
  document.getElementById("clear-filters").addEventListener("click", () => {
    document.getElementById("f-search").value = "";
    document.getElementById("f-state").value = "";
    document.getElementById("f-county").value = "";
    document.getElementById("f-type").value = "";
    document.getElementById("f-status").value = "";
    document.getElementById("f-loan-category").value = "";
    document.getElementById("f-has-contact").checked = false;
    document.getElementById("f-overridden").checked = false;
    document.getElementById("f-flagged").checked = false;
    document.getElementById("f-maturity-from").value = "";
    document.getElementById("f-maturity-to").value = "";
    clearMaturityPresetActive();
    applyFilters();
  });
  document.getElementById("drawer-close").addEventListener("click", closeDrawer);
  document.getElementById("overlay").addEventListener("click", closeDrawer);

  document.getElementById("dismiss-banner").addEventListener("click", () => {
    document.getElementById("proto-banner").classList.add("hidden");
    document.getElementById("main").classList.add("no-banner");
    document.querySelectorAll(".queue-view").forEach(el => el.classList.add("no-banner"));
  });

  document.querySelectorAll(".view-tab").forEach(tab => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  document.getElementById("add-property-btn").addEventListener("click", () => startPinPlacement("new"));
  document.getElementById("pin-placement-cancel").addEventListener("click", cancelPinPlacement);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && placingPinFor) cancelPinPlacement();
  });

  // sub-filter buttons (All/Unclaimed/Mine) are scoped per view — Calling List and Leads
  // each keep their own independent scope and active state
  document.querySelectorAll("#calling-list-view .sub-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      callingScope = btn.dataset.scope;
      document.querySelectorAll("#calling-list-view .sub-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderCallingList();
    });
  });
  document.querySelectorAll("#leads-view .sub-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      leadsScope = btn.dataset.scope;
      document.querySelectorAll("#leads-view .sub-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderLeadsList();
    });
  });
  document.querySelectorAll("#tracked-view .sub-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      trackedScope = btn.dataset.scope;
      document.querySelectorAll("#tracked-view .sub-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderTrackedList();
    });
  });
}
