const de = {
  sheets: "Blätter",
  undo: "Rückgängig",
  redo: "Wiederholen",
  fit: "Ansicht einpassen",
  share: "Als Bild teilen oder speichern",
  more: "Mehr",
  tools: "Werkzeuge",
  pen: "Stift",
  shape: "Formen",
  line: "Linie",
  rect: "Viereck",
  ellipse: "Oval",
  eraser: "Radierer",
  text: "Text",
  color: "Farbe",
  size: "Stärke",
  fontSize: "Schriftgröße",
  paper: "Papier",
  fill: "Füllen",
  custom: "Eigene Farbe",
  newSheet: "Neues Blatt",
  clear: "Blatt leeren",
  fullscreen: "Vollbild",
  exitFullscreen: "Vollbild beenden",
  hideBars: "Leisten ausblenden",
  showBars: "Leisten zeigen",
  install: "Als App installieren",
  fingersDraw: "Mit Finger zeichnen",
  clearTitle: "Blatt leeren?",
  clearBody: "Alle Striche werden entfernt. „Rückgängig“ holt sie zurück.",
  cancel: "Abbrechen",
  confirmClear: "Leeren",
  deleteTitle: "Blatt löschen?",
  deleteBody: "Das Blatt wird endgültig von diesem Gerät gelöscht.",
  delete: "Löschen",
  close: "Schließen",
  hint: "Einfach loszeichnen",
  hint2: "2 Finger: zoomen & schieben · 2-Finger-Tipp: rückgängig",
  textHint: "Tippe aufs Blatt, um Text zu setzen",
  textPlaceholder: "Dein Text",
  place: "Setzen",
  penDetected: "Stift erkannt – Finger zoomen & schieben jetzt nur noch",
  updateReady: "Neue Version verfügbar",
  reload: "Neu laden",
  imageSaved: "Bild gespeichert",
  saveFailed: "Speichern nicht möglich – privater Modus?",
  iosInstall: "Tippe auf „Teilen“ und dann „Zum Home-Bildschirm“",
  offlineReady: "Bereit – funktioniert jetzt auch offline",
  empty: "leer",
  marks: "Striche",
  zoom: "Zoom",
  inks: ["Tinte", "Kreide", "Grau", "Rot", "Orange", "Gelb", "Grün", "Kiefer", "Blau", "Schiefer", "Lila", "Pink", "Braun", "Oxidrot"],
  papers: ["Natur", "Weiß", "Nebel", "Sand", "Nacht"],
};

type Dict = typeof de;

const en: Dict = {
  sheets: "Sheets",
  undo: "Undo",
  redo: "Redo",
  fit: "Fit to screen",
  share: "Share or save as image",
  more: "More",
  tools: "Tools",
  pen: "Pen",
  shape: "Shapes",
  line: "Line",
  rect: "Rectangle",
  ellipse: "Oval",
  eraser: "Eraser",
  text: "Text",
  color: "Colour",
  size: "Size",
  fontSize: "Font size",
  paper: "Paper",
  fill: "Fill",
  custom: "Custom colour",
  newSheet: "New sheet",
  clear: "Clear sheet",
  fullscreen: "Full screen",
  exitFullscreen: "Exit full screen",
  hideBars: "Hide toolbars",
  showBars: "Show toolbars",
  install: "Install as app",
  fingersDraw: "Draw with finger",
  clearTitle: "Clear this sheet?",
  clearBody: "All strokes will be removed. Undo brings them back.",
  cancel: "Cancel",
  confirmClear: "Clear",
  deleteTitle: "Delete sheet?",
  deleteBody: "This sheet will be permanently removed from this device.",
  delete: "Delete",
  close: "Close",
  hint: "Just start drawing",
  hint2: "2 fingers: zoom & pan · 2-finger tap: undo",
  textHint: "Tap the sheet to place text",
  textPlaceholder: "Your text",
  place: "Place",
  penDetected: "Stylus detected – fingers now only zoom & pan",
  updateReady: "New version available",
  reload: "Reload",
  imageSaved: "Image saved",
  saveFailed: "Couldn't save – private mode?",
  iosInstall: "Tap “Share”, then “Add to Home Screen”",
  offlineReady: "Ready – now works offline too",
  empty: "empty",
  marks: "strokes",
  zoom: "Zoom",
  inks: ["Ink", "Chalk", "Grey", "Red", "Orange", "Yellow", "Green", "Pine", "Blue", "Slate", "Purple", "Pink", "Brown", "Rust"],
  papers: ["Natural", "White", "Mist", "Sand", "Night"],
};

const lang = (navigator.language || "de").toLowerCase().startsWith("de") ? "de" : "en";
export const t: Dict = lang === "de" ? de : en;
export const LANG = lang;

/** Fill [data-i18n] text and [data-i18n-label] aria-label/title in static markup. */
export function translateDom(root: ParentNode = document) {
  document.documentElement.lang = lang;
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t[el.dataset.i18n as keyof Dict] as string;
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-label]").forEach((el) => {
    const label = t[el.dataset.i18nLabel as keyof Dict] as string;
    el.setAttribute("aria-label", label);
    el.title = label;
  });
  root.querySelectorAll<HTMLInputElement>("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t[el.dataset.i18nPh as keyof Dict] as string;
  });
}
