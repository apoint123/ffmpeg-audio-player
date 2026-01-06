export type Pointer = number;
export type FSFilesystemWORKERFS = object;

export interface Stat {
	dev: number;
	ino: number;
	mode: number;
	nlink: number;
	uid: number;
	gid: number;
	rdev: number;
	size: number;
	atime: string;
	mtime: string;
	ctime: string;
	blksize: number;
	blocks: number;
}

export interface FS {
	mkdir: (path: string) => void;
	rmdir: (path: string) => void;
	rename: (oldPath: string, newPath: string) => void;
	writeFile: (path: string, data: Uint8Array | string) => void;
	readFile: (path: string, opts: { encoding: string }) => Uint8Array | string;
	readdir: (path: string) => string[];
	unlink: (path: string) => void;
	stat: (path: string) => Stat;
	mount: (
		fileSystemType: FSFilesystemWORKERFS,
		data: { files?: File[]; blobs?: { name: string; data: Blob }[] },
		path: string,
	) => void;
	unmount: (path: string) => void;
	filesystems: {
		WORKERFS: FSFilesystemWORKERFS;
	};
}

export interface FFmpegCoreModule {
	FS: FS;
}

export interface EmbindObject {
	delete(): void;
	isDeleted(): boolean;
}

export interface StringList extends EmbindObject {
	size(): number;
	get(index: number): string;
}

export interface StringMap extends EmbindObject {
	keys(): StringList;
	get(key: string): string;
	set(key: string, value: string): void;
	size(): number;
}

export interface Uint8List extends EmbindObject {
	size(): number;
	get(index: number): number;
}

export interface DecoderStatus {
	status: number;
	error: string;
}

export interface AudioProperties {
	status: DecoderStatus;
	encoding: string;
	sampleRate: number;
	channelCount: number;
	duration: number;
	metadata: StringMap;
	coverArt: Uint8List;
	bitsPerSample: number;
}

export interface ChunkResult {
	status: DecoderStatus;
	samples: Float32Array;
	isEOF: boolean;
	startTime: number;
}

export interface AudioStreamDecoder extends EmbindObject {
	init(path: string): AudioProperties;
	readChunk(chunkSize: number): ChunkResult;
	seek(timestamp: number): DecoderStatus;
	close(): void;
}

export interface AudioDecoderModule extends FFmpegCoreModule {
	AudioStreamDecoder: {
		new (): AudioStreamDecoder;
	};
	WORKERFS: FSFilesystemWORKERFS;
}
