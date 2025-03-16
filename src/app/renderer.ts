import SamJs from "sam-js";
import soundConfig from "../shared/sounds.json";
import { SoundConfig } from "../shared/types";

let sam = new SamJs();
const sounds = (soundConfig as SoundConfig).sounds;

function sayWords(words: string) {
	sam.speak(words);
}

function playSound(id: string) {
	var audio = document.getElementById(id) as HTMLAudioElement;
	audio.play();
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
	for (const key in sounds) {
		const sound = sounds[key];
		const button = create_audio(sound);
		document.body.appendChild(button);
	}

	sayWords("System Tray Ready");
} catch (e) {
	console.error(e);
	alert("error: " + e.message);
}
