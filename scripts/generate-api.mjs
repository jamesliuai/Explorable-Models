import { writeFile } from 'node:fs/promises';
import { DOCUMENT_SCHEMA, DOCUMENT_LIMITS } from '../packages/core/dist/declarative/index.js';
import { ACTIVITY_TOOL_DESCRIPTORS, VISUALIZATION_TOOL_DESCRIPTORS } from '../packages/agent/dist/index.js';
for(const [file,value] of [['document-schema.json',DOCUMENT_SCHEMA],['document-limits.json',DOCUMENT_LIMITS],['tool-schemas.json',VISUALIZATION_TOOL_DESCRIPTORS],['study-harness/activity-tool-schemas.json',ACTIVITY_TOOL_DESCRIPTORS]]) await writeFile(new URL(`../docs/${file}`,import.meta.url),JSON.stringify(value,null,2)+'\n');
