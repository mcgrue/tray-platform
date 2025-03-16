export interface Sound {
	id: string;
	file: string;
	description: string;
	endpoints: string[];
}

export interface SoundConfig {
	sounds: {
		[key: string]: Sound;
	};
}
