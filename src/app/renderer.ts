import SamJs from "sam-js";
import soundConfig from "../shared/sounds.json";
import { SoundConfig } from "../shared/types";
import { AttentionBridge, NavigationBridge } from "../shared/attention";
import { mountAttentionUI } from "./attention-ui";
import { mountNavigationUI } from "./navigation-ui";
import "../shared/bridge";
import { createBookmarkUI } from "./bookmark-ui";
import { mountTitlebar } from "./titlebar";
import { mountCodexInstancesUI } from "./codex-instances-ui";

const disposeTitlebar = mountTitlebar(document.getElementById("app-titlebar")!, window.ipcComms);
window.addEventListener("beforeunload", disposeTitlebar, { once: true });

let sam = new SamJs();
const sounds = (soundConfig as SoundConfig).sounds;

function sayWords(words: string) {
	sam.speak(words);
}

function playSound(id: string) {
	var audio = document.getElementById(id) as HTMLAudioElement;

	// if there's already audio playing: stop it
	if (audio && !audio.paused) {
		audio.pause();
		audio.currentTime = 0;
	}

	if (audio) void audio.play().catch((error) => console.error("Sound playback failed:", error));
}

function create_audio(sound: { id: string; file: string }): HTMLButtonElement {
	const button = document.createElement("button");
	button.onclick = () => {
		playSound(sound.id);
	};
	button.innerText = sound.id;

	const audio = document.createElement("audio");
	audio.src = sound.file;
	audio.id = sound.id;

	button.appendChild(audio);
	return button;
}

console.log("here I go, rendering again!");

// Set up IPC handlers
window["ipcComms"].onShowAlert((value) => {
	alert(value);
});

window["ipcComms"].onRefreshPage((value) => {
	location.reload();
});

window["ipcComms"].onPlaySound((value) => {
	playSound(value);
});

window["ipcComms"].onSayWords((value) => {
	sayWords(value);
});

try {
	const bookmarks = createBookmarkUI(window.ipcComms);
	const navigationRoot = document.createElement("section");
	navigationRoot.id = "navigation";
	document.body.appendChild(navigationRoot);
	const disposeNavigation = mountNavigationUI(navigationRoot, window["ipcComms"] as NavigationBridge, {
		resumeText: bookmarks.resumeText, onResumeChanged: bookmarks.onChanged,
	});
	window.addEventListener("beforeunload", disposeNavigation, { once: true });
	const inboxRoot = document.createElement("main");
	document.body.appendChild(inboxRoot);
	const disposeInbox = mountAttentionUI(inboxRoot, window["ipcComms"] as AttentionBridge, { mountDetails: bookmarks.mountAttentionDetails });
	window.addEventListener("beforeunload", disposeInbox, { once: true });
	const codexRoot = document.createElement("section");
	codexRoot.id = "codex-instances";
	document.body.appendChild(codexRoot);
	const disposeCodex = mountCodexInstancesUI(codexRoot, window.ipcComms);
	window.addEventListener("beforeunload", disposeCodex, { once: true });
	const bookmarkRoot = document.createElement("section");
	bookmarkRoot.id = "bookmarks";
	document.body.appendChild(bookmarkRoot);
	const disposeBookmarks = bookmarks.mount(bookmarkRoot);
	window.addEventListener("beforeunload", () => { disposeBookmarks(); bookmarks.dispose(); }, { once: true });
	const soundboard = document.createElement("section");
	soundboard.id = "soundboard";
	soundboard.setAttribute("aria-label", "Sound board");
	const heading = document.createElement("h2");
	heading.textContent = "Sound board";
	soundboard.appendChild(heading);
	document.body.appendChild(soundboard);
	// Existing sound buttons
	for (const key in sounds) {
		const sound = sounds[key];
		const button = create_audio(sound);
		soundboard.appendChild(button);
	}

	// Only show config button if we're in dev mode
	window["ipcComms"].isDevMode().then((isDevMode) => {
		if (isDevMode) {
			// Add config edit button
			const configButton = document.createElement("button");
			configButton.innerText = "Edit Sound Configuration";
			configButton.style.display = "block";
			configButton.style.marginTop = "20px";
			configButton.onclick = () => {
				window["ipcComms"].openSoundConfig();
			};
			soundboard.appendChild(configButton);
		}
	});

	sayWords("System Tray Ready");
} catch (e) {
	console.error(e);
	alert("error: " + (e instanceof Error ? e.message : String(e)));
}
