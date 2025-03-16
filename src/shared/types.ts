export interface Sound {
  id: string;
  file: string;
  description: string;
}

export interface SoundConfig {
  sounds: {
    [key: string]: Sound;
  };
}