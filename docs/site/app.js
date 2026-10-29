const data = await fetch("/assets/package.json").then(response => {
  if (!response.ok) throw new Error("Package documentation could not be loaded");
  return response.json();
});
const content = document.getElementById("content");
const navigation = document.getElementById("navigation");
const layout = document.querySelector(".layout");
const search = document.getElementById("search");
const results = document.getElementById("results");

function escape(value) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
function href(value) {
  if (/^https?:\/\//.test(value) || value.startsWith("#")) return escape(value);
  if (/^[\w./-]+$/.test(value)) return escape(data.repository + "/blob/v" + data.version + "/" + value.replace(/^\.\//, ""));
  return "#";
}
function inline(value) {
  return value.split(/(`[^`]+`)/g).map(part => {
    if (part.startsWith("`") && part.endsWith("`")) return "<code>" + escape(part.slice(1, -1)) + "</code>";
    return escape(part).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, link) => `<a href="${href(link.replaceAll("&amp;", "&"))}">${label}</a>`);
  }).join("");
}
function code(value) {
  return `<div class="code"><button type="button" data-copy>Copy</button><pre><code>${escape(value)}</code></pre></div>`;
}
function markdown(source) {
  const output = [];
  let paragraph = [];
  let list = [];
  let ordered = false;
  let fence = null;
  const flushParagraph = () => { if (paragraph.length) output.push("<p>" + inline(paragraph.join(" ")) + "</p>"); paragraph = []; };
  const flushList = () => { if (list.length) { const tag = ordered ? "ol" : "ul"; output.push(`<${tag}>${list.map(line => "<li>" + inline(line) + "</li>").join("")}</${tag}>`); } list = []; };
  for (const line of source.split("\n")) {
    if (line.startsWith("```")) {
      flushParagraph(); flushList();
      if (fence !== null) { output.push(code(fence.join("\n"))); fence = null; }
      else fence = [];
      continue;
    }
    if (fence !== null) { fence.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^(#{1,4})\s+(.+)/);
    if (heading) { flushParagraph(); flushList(); const level = Math.min(heading[1].length, 3); output.push(`<h${level}>${inline(heading[2])}</h${level}>`); continue; }
    const item = line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)/);
    if (item) {
      flushParagraph();
      const nextOrdered = !item[1];
      if (list.length && ordered !== nextOrdered) flushList();
      ordered = nextOrdered; list.push(item[2]); continue;
    }
    flushList(); paragraph.push(line.trim());
  }
  flushParagraph(); flushList();
  if (fence !== null) output.push(code(fence.join("\n")));
  return output.join("\n");
}
function route(tab, item) {
  return "?tab=" + encodeURIComponent(tab) + (item ? "&item=" + encodeURIComponent(item) : "");
}
function link(label, tab, item, active = false) {
  return `<a href="${route(tab, item)}" data-route${active ? ' aria-current="page"' : ""}>${escape(label)}</a>`;
}
function apiOverview() {
  let html = "<h1>API reference</h1><p>Sketch APIs are available on the injected <code>KAPPlus</code> object. Node APIs are imported from <code>kapplus</code> in build tools and scripts.</p>";
  for (const category of ["Sketch runtime", "Generated assets", "Node API"]) {
    html += `<h2>${escape(category)}</h2><table class="api-list"><tbody>`;
    for (const item of data.api.filter(item => item.category === category)) {
      html += `<tr><td>${link(item.id, "api", item.id)}</td><td><p>${escape(item.summary)}</p></td></tr>`;
    }
    html += "</tbody></table>";
  }
  return html;
}
function render() {
  const query = new URLSearchParams(location.search);
  const tab = query.get("tab") || "readme";
  const itemId = query.get("item");
  navigation.hidden = tab !== "api" && tab !== "guides";
  layout.classList.toggle("with-navigation", !navigation.hidden);
  document.querySelectorAll(".tabs [data-tab]").forEach(element => {
    if (element.dataset.tab === tab) element.setAttribute("aria-current", "page");
    else element.removeAttribute("aria-current");
  });
  if (tab === "api") {
    navigation.innerHTML = "<h2>API reference</h2>" + link("All APIs", "api", null, !itemId) +
      ["Sketch runtime", "Generated assets", "Node API"].map(category => `<p class="section">${escape(category)}</p>` +
        data.api.filter(item => item.category === category).map(item => link(item.id, "api", item.id, itemId === item.id)).join("")).join("");
    const item = data.api.find(item => item.id === itemId);
    content.innerHTML = item
      ? `<h1>${escape(item.id)}</h1><p class="muted">${escape(item.summary)}</p><div class="signature">${escape(item.signature)}</div>${markdown(item.body)}`
      : itemId ? "<h1>API not found</h1><p>Choose an entry from the reference navigation.</p>" : apiOverview();
    document.title = `${item ? item.id : "API reference"} — KAP+ ${data.version}`;
  } else if (tab === "guides") {
    navigation.innerHTML = "<h2>Guides</h2>" + link("All guides", "guides", null, !itemId) + data.guides.map(item => link(item.title, "guides", item.id, itemId === item.id)).join("");
    const item = data.guides.find(item => item.id === itemId);
    content.innerHTML = item ? markdown(item.body) : '<h1>Guides</h1><div class="guide-list">' + data.guides.map(item =>
      `<a href="${route("guides", item.id)}" data-route><strong>${escape(item.title)}</strong><span>${escape(item.summary)}</span></a>`).join("") + "</div>";
    if (item?.id === "configuration") content.innerHTML += "<h2>Defaults for a minimal manifest</h2>" + code(JSON.stringify(data.defaults, null, 2));
    document.title = `${item ? item.title : "Guides"} — KAP+ ${data.version}`;
  } else if (tab === "versions") {
    content.innerHTML = '<h1>Versions</h1><p>Standalone releases contain the built SDK. Installation CI exercises the packed tarball in a clean consumer project.</p><table class="details"><thead><tr><th>Version</th><th>Release</th></tr></thead><tbody>' +
      data.versions.map(item => `<tr><td><code>${escape(item.version)}</code>${item.version === data.version ? " · latest" : ""}</td><td><a href="${href(item.url)}">View release and package archive</a></td></tr>`).join("") + "</tbody></table>";
    document.title = `Versions — KAP+ ${data.version}`;
  } else if (tab === "dependencies") {
    content.innerHTML = '<h1>Dependencies</h1><p>Runtime dependencies declared by this SDK release. The resolved column comes from its committed lockfile.</p><table class="details"><thead><tr><th>Package</th><th>Requested</th><th>Resolved</th></tr></thead><tbody>' +
      data.dependencies.map(item => `<tr><td><a href="${href(item.url)}">${escape(item.name)}</a></td><td><code>${escape(item.range)}</code></td><td><code>${escape(item.resolved || "—")}</code></td></tr>`).join("") + "</tbody></table>";
    document.title = `Dependencies — KAP+ ${data.version}`;
  } else {
    content.innerHTML = markdown(data.readme);
    document.title = `kapplus ${data.version} — package documentation`;
  }
  results.hidden = true;
  search.setAttribute("aria-expanded", "false");
}

document.getElementById("description").textContent = data.description;
document.getElementById("version-label").textContent = data.version;
document.getElementById("install").textContent = data.install;
document.getElementById("meta-version").textContent = data.version;
document.getElementById("node-version").textContent = data.engines.node;
document.getElementById("license").textContent = data.license || "Not specified";
document.getElementById("footer-version").textContent = data.name + " " + data.version;
document.getElementById("release-link").href = data.versions[0].url;

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
    document.getElementById("announcement").textContent = "Copied to clipboard";
    setTimeout(() => { button.textContent = "Copy"; }, 1400);
  } catch {
    button.textContent = "Select and copy";
    const range = document.createRange();
    range.selectNodeContents(button.closest(".code")?.querySelector("code") || document.getElementById("install"));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
}
document.getElementById("copy-install").onclick = event => copy(data.install, event.currentTarget);
document.addEventListener("click", event => {
  const button = event.target.closest("button[data-copy]");
  if (button) { void copy(button.closest(".code").querySelector("code").textContent, button); return; }
  const anchor = event.target.closest("a[data-tab],a[data-route]");
  if (!anchor || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); history.pushState(null, "", anchor.href); render(); scrollTo(0, 0);
});
addEventListener("popstate", render);

const index = [
  { title: "Install KAP+", summary: "Set up a standalone project", tab: "readme", id: null, search: "install init getting started setup" },
  ...data.api.map(item => ({ title: item.id, summary: item.summary, tab: "api", id: item.id, search: item.id + " " + item.summary + " " + item.signature })),
  ...data.guides.map(item => ({ title: item.title, summary: item.summary, tab: "guides", id: item.id, search: item.title + " " + item.summary })),
];
search.addEventListener("input", () => {
  const terms = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  results.hidden = !terms.length;
  search.setAttribute("aria-expanded", String(!!terms.length));
  if (!terms.length) return;
  const matches = index.filter(item => terms.every(term => item.search.toLowerCase().includes(term))).slice(0, 10);
  results.innerHTML = matches.length ? matches.map(item => `<a href="${route(item.tab, item.id)}" data-route><strong>${escape(item.title)}</strong><span>${escape(item.summary)}</span></a>`).join("") : "<p>No matching API or guide.</p>";
});
document.addEventListener("keydown", event => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName) && !event.metaKey && !event.ctrlKey) { event.preventDefault(); search.focus(); }
  if (event.key === "Escape") { search.value = ""; results.hidden = true; search.setAttribute("aria-expanded", "false"); search.blur(); }
  if (event.key === "ArrowDown" && document.activeElement === search && !results.hidden) { event.preventDefault(); results.querySelector("a")?.focus(); }
});
render();
