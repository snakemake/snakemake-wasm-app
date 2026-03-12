import type { InputFilePayload } from '$lib/types/workflow';

export function normalizeVmOutputPath(relativePath: string): string | null {
	const rel = String(relativePath || '').trim().replace(/^\.\//, '');
	if (!rel || rel.includes('..') || rel.startsWith('/')) {
		return null;
	}
	return `/root/${rel}`;
}

export function toWorkerFilePayload(files: Map<string, InputFilePayload>): InputFilePayload[] {
	return [...files.values()].map((file) => ({
		path: file.path,
		encoding: file.encoding,
		content: file.content
	}));
}
