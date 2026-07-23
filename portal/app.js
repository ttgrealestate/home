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
  "owner", "adjusted_owner", "owner_contact",
  "address", "city", "zip", "year_built", "units", "sale_price", "sale_date",
  "mailing_address", "mailing_city", "mailing_state"
];
const CONTACT_COLORS = ["green", "yellow", "red"]; // cycle order; null = untagged

const FIELD_LABELS = {
  owner: "Owner (raw)",
  adjusted_owner: "Adjusted Owner",
  owner_contact: "Owner Contact",
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

// Phones/emails support multiple entries plus a red/green/yellow tag per entry, so they're
// stored as [{value, color}] once an associate touches them, separately from the simple
// single-value overrides used for other fields. Master data (plain strings) has color: null.
function getContactEntries(prop, field) {
  const rec = CRM[prop.id];
  if (rec && rec.overrides && rec.overrides[field]) return rec.overrides[field];
  return (prop[field] || []).map(v => ({ value: v, color: null }));
}
function setContactEntries(prop, field, entries) {
  const rec = getRecord(prop.id);
  rec.overrides[field] = entries;
  saveCRM(prop.id);
  openDrawer(prop.id);
  renderList();
  renderStats();
}
function propertyType(prop) {
  const u = prop.units;
  if (!u || u <= 1) return "sfr";
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
  return { not_contacted: "Not Contacted", needs_databasing: "Needs Databasing", contacted: "Contacted" }[s] || "Not Contacted";
}
function fmtMoney(v) {
  if (!v) return "—";
  return v;
}
function fullAddress(prop) {
  const addr = effectiveValue(prop, "address");
  const city = effectiveValue(prop, "city");
  const zip = effectiveValue(prop, "zip");
  return [addr, city ? city + ", CO" : "", zip].filter(Boolean).join(", ");
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

    await loadCRM();
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
  const counties = [...new Set(PROPERTIES.map(p => p.county))].sort();
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
  return { not_contacted: "#8a8f98", needs_databasing: "#c98a2c", contacted: "#3f8f5f" }[status] || "#8a8f98";
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
  const color = statusColor(rec.status);
  const marker = L.circleMarker([prop.lat, prop.lon], {
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
  return `<b>${escapeHtml(owner)}</b><br>${escapeHtml(fullAddress(prop))}<br><span style="color:#8a8f98">${propertyTypeLabel(prop)} · ${prop.units || "?"} units · ${prop.county} Co.</span>`;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── filtering ────────────────────────────────────────────────
function currentFilters() {
  return {
    search: document.getElementById("f-search").value.trim().toLowerCase(),
    county: document.getElementById("f-county").value,
    type: document.getElementById("f-type").value,
    status: document.getElementById("f-status").value,
    hasContact: document.getElementById("f-has-contact").checked,
    overriddenOnly: document.getElementById("f-overridden").checked,
    maturityFrom: document.getElementById("f-maturity-from").value,
    maturityTo: document.getElementById("f-maturity-to").value
  };
}

function matchesFilters(prop, f) {
  if (f.county && prop.county !== f.county) return false;
  if (f.type && propertyType(prop) !== f.type) return false;
  const rec = getRecord(prop.id);
  if (f.status && rec.status !== f.status) return false;
  if (f.overriddenOnly && (!rec.overrides || Object.keys(rec.overrides).length === 0)) return false;
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
  return `
  <div class="prop-row${prop.id === activeId ? " active" : ""}" data-id="${escapeHtml(prop.id)}">
    <div class="prop-row-top">
      <div class="status-dot status-${rec.status}"></div>
      <div style="flex:1">
        <div class="prop-addr">${escapeHtml(addr || "Address unknown")}</div>
        <div class="prop-sub">${escapeHtml(owner)}</div>
        <div class="prop-meta">
          <span>${propertyTypeLabel(prop)}</span>
          <span>${prop.units || "?"} units</span>
          <span>${prop.county} Co.</span>
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
    if (p.lat == null || p.lon == null) return;
    const m = buildMarker(p, style);
    markerIndex[p.id] = m;
    markerLayer.addLayer(m);
  });
  applyMarkerSelection();
}

function renderStats() {
  document.getElementById("stat-total").textContent = PROPERTIES.length.toLocaleString();
  let contacted = 0, needs = 0, overridden = 0;
  PROPERTIES.forEach(p => {
    const rec = CRM[p.id];
    if (rec) {
      if (rec.status === "contacted") contacted++;
      if (rec.status === "needs_databasing") needs++;
      if (rec.overrides && Object.keys(rec.overrides).length > 0) overridden++;
    }
  });
  document.getElementById("stat-contacted").textContent = contacted.toLocaleString();
  document.getElementById("stat-needs").textContent = needs.toLocaleString();
  document.getElementById("stat-overrides").textContent = overridden.toLocaleString();
}

// ── drawer / CRM detail ──────────────────────────────────────
function openDrawer(id) {
  activeId = id;
  const prop = PROPERTIES.find(p => p.id === id);
  if (!prop) return;
  const rec = getRecord(id);

  document.getElementById("d-addr").textContent = fullAddress(prop) || "Address unknown";
  document.getElementById("d-sub").textContent = `${prop.county} County · APN ${prop.apn || "—"} · ${propertyTypeLabel(prop)}`;

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
      <span class="v-display">${escapeHtml(display)}<span class="edit-pencil" data-edit="${field}">&#9998;</span></span>
      ${overridden ? `<span class="diff-badge">Data differs from master set<span class="revert-link" data-revert="${field}">Revert</span></span>` : ""}
    </div>
  </div>`;
}

function contactEntryHtml(field, entry, idx) {
  const isPhone = field === "phones";
  const href = (isPhone ? "tel:" : "mailto:") + encodeURIComponent(entry.value);
  const dotClass = entry.color ? `dot-${entry.color}` : "dot-none";
  const valClass = entry.color ? `tagged-${entry.color}` : "";
  return `
  <div class="contact-entry" data-field="${field}" data-idx="${idx}">
    <span class="color-dot ${dotClass}" data-cycle-color title="Click to tag: none → green → yellow → red"></span>
    <a href="${href}" class="contact-value ${valClass}">${escapeHtml(entry.value)}</a>
    <span class="contact-remove" data-remove-entry title="Remove">&times;</span>
  </div>`;
}

function contactGroupHtml(prop, field, label, placeholder) {
  const entries = getContactEntries(prop, field);
  return `
  <div class="contact-group">
    <div class="contact-group-label">${label}</div>
    <div class="contact-entries">
      ${entries.length ? entries.map((e, i) => contactEntryHtml(field, e, i)).join("") : `<div class="contact-empty">None on file</div>`}
    </div>
    <div class="contact-add-row">
      <input type="text" class="contact-add-input" data-add-field="${field}" placeholder="${placeholder}" />
      <button class="contact-add-btn" data-add-field="${field}" type="button">Add</button>
    </div>
  </div>`;
}

function drawerBodyHtml(prop, rec) {
  const contactOverridden = isOverridden(prop, "phones") || isOverridden(prop, "emails");

  return `
  <div class="d-section">
    <h4>CRM Status</h4>
    <div class="status-buttons">
      <button class="status-btn${rec.status === "not_contacted" ? " active" : ""}" data-status="not_contacted">Not Contacted</button>
      <button class="status-btn${rec.status === "needs_databasing" ? " active" : ""}" data-status="needs_databasing">Needs Databasing</button>
      <button class="status-btn${rec.status === "contacted" ? " active" : ""}" data-status="contacted">Contacted</button>
    </div>
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
    ${editableField(prop, "owner_contact")}
    ${editableField(prop, "mailing_address")}
    ${editableField(prop, "mailing_city")}
    ${editableField(prop, "mailing_state")}
  </div>

  <div class="d-section">
    <div class="d-section-head">
      <h4>Contact Info</h4>
      ${contactOverridden ? `<span class="diff-badge inline">Data differs from master set<span class="revert-link" data-revert-contact="1">Revert</span></span>` : ""}
    </div>
    ${contactGroupHtml(prop, "phones", "Phone Numbers", "Add phone…")}
    ${contactGroupHtml(prop, "emails", "Emails", "Add email…")}
  </div>

  <div class="d-section">
    <h4>Loan Maturity</h4>
    ${loanSectionHtml(prop)}
  </div>
  `;
}

function loanSectionHtml(prop) {
  const loans = prop.loans || [];
  if (loans.length === 0) {
    return `<div class="loan-placeholder">No loan record matched this address in the Colorado loan data.</div>`;
  }
  const current = loans[0];
  const history = loans.slice(1);
  return `
    <div class="loan-caption">Matched by property address from the Colorado&nbsp;-&nbsp;Loans sheet${loans.length > 1 ? ` · ${loans.length} loans on file, most recent shown first` : ""}.</div>
    <div class="loan-current">
      <div class="loan-row"><span class="k">Lender</span><span class="v">${escapeHtml(current.lender || "—")}</span></div>
      <div class="loan-row"><span class="k">Borrower</span><span class="v">${escapeHtml(current.borrower || "—")}</span></div>
      <div class="loan-row"><span class="k">Loan Amount</span><span class="v">${escapeHtml(current.mortgage_amount || "—")}</span></div>
      <div class="loan-row"><span class="k">Origination</span><span class="v">${escapeHtml(current.origination_date || "—")}</span></div>
      <div class="loan-row"><span class="k">Maturity</span><span class="v loan-maturity-val">${escapeHtml(current.maturity_date || "—")}</span></div>
      <div class="loan-row"><span class="k">Lender Type</span><span class="v">${escapeHtml(current.lender_type || "—")}</span></div>
      <div class="loan-row"><span class="k">Transaction Type</span><span class="v">${escapeHtml(current.property_type || "—")}</span></div>
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
      renderMarkers();
      renderStats();
    });
  });

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
  document.querySelectorAll("[data-revert-contact]").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      delete rec.overrides.phones;
      delete rec.overrides.emails;
      saveCRM(prop.id);
      openDrawer(prop.id);
      renderList();
      renderStats();
    });
  });
}

function addContactEntry(prop, field) {
  const input = document.querySelector(`.contact-add-input[data-add-field="${field}"]`);
  const val = input.value.trim();
  if (!val) return;
  const entries = getContactEntries(prop, field).slice();
  entries.push({ value: val, color: null });
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
  ["f-search", "f-county", "f-type", "f-status", "f-has-contact", "f-overridden", "f-maturity-from", "f-maturity-to"].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener(el.tagName === "INPUT" && el.type === "text" ? "input" : "change", () => {
      clearMaturityPresetActive();
      applyFilters();
    });
  });
  document.querySelectorAll(".preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
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
    document.getElementById("f-county").value = "";
    document.getElementById("f-type").value = "";
    document.getElementById("f-status").value = "";
    document.getElementById("f-has-contact").checked = false;
    document.getElementById("f-overridden").checked = false;
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
  });
}
