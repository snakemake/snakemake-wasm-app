export type FileEncoding = 'utf-8' | 'base64';

export interface InputFilePayload {
	path: string;
	encoding: FileEncoding;
	content: string;
}

export interface OutputFilePayload {
	path: string;
	encoding: FileEncoding;
	text?: string;
	base64?: string;
}

export interface WorkflowResultPayload {
	run_ok?: boolean;
	output_files?: OutputFilePayload[];
	updated_files?: string[];
	written_files?: string[];
	config_file?: string;
	python?: string;
}

export interface ShellSyncedFile {
	path: string;
	encoding: 'base64' | 'utf-8';
	base64?: string;
	text?: string;
}
