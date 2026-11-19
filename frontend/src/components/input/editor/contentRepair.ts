import {DOMParser as ProseMirrorDOMParser, Fragment, Slice} from '@tiptap/pm/model'
import type {ContentMatch, Node as ProseMirrorNode, ParseOptions, Schema} from '@tiptap/pm/model'

/**
 * ProseMirror happily builds nodes its own schema rejects, and only blows up later
 * while placing them: the html parser turns markdown like "- " into a listItem without
 * the paragraph it requires, and the clipboard re-wraps content in whatever node types
 * a foreign `data-pm-slice` names, so a listItem can end up holding bare text. Both make
 * prosemirror-transform dereference a null `ContentMatch` (FRONTEND-OSS-2H9) or reject
 * the node outright (FRONTEND-OSS-2JY/2JZ), which kills the editor.
 *
 * Repairing content here means everything downstream only ever sees nodes the schema
 * can hold.
 */

/**
 * Fills in nodes required to make every node in `fragment` fully valid. Use for content
 * that is inserted as-is, where ProseMirror checks whole nodes rather than prefixes.
 */
export function fillRequiredContent(fragment: Fragment): Fragment {
	return repairFragment(fragment, true)
}

/**
 * Repairs a pasted slice. A slice's nodes are open at the edges, so their content only
 * has to be a valid *prefix* — closing them completely would insert filler the user
 * never copied.
 */
export function repairSliceContent(slice: Slice): Slice {
	const content = repairFragment(slice.content, false)
	return new Slice(content, openDepth(content, slice.openStart), openDepth(content, slice.openEnd, true))
}

/**
 * A clipboard parser that repairs its output. `transformPasted` runs too late for this:
 * prosemirror-view closes the parsed slice before handing it over, and throws while
 * doing so when a node's content does not fit its type.
 */
export function createClipboardParser(schema: Schema): ProseMirrorDOMParser {
	return new RepairingClipboardParser(schema, ProseMirrorDOMParser.fromSchema(schema).rules)
}

class RepairingClipboardParser extends ProseMirrorDOMParser {
	parseSlice(dom: HTMLElement, options?: ParseOptions): Slice {
		return repairSliceContent(super.parseSlice(dom, options))
	}
}

function repairFragment(fragment: Fragment, toEnd: boolean): Fragment {
	const children: ProseMirrorNode[] = []
	fragment.forEach(child => children.push(repairNode(child, toEnd)))
	return Fragment.fromArray(children)
}

function repairNode(node: ProseMirrorNode, toEnd: boolean): ProseMirrorNode {
	if (node.isLeaf) {
		return node
	}

	const content = repairFragment(node.content, toEnd)
	const match = node.type.contentMatch

	if (toEnd ? node.type.validContent(content) : match.matchFragment(content) !== null) {
		return node.copy(content)
	}

	const missing = match.fillBefore(content, toEnd)
	return node.copy(missing ? missing.append(content) : fitContent(match, content))
}

// No amount of filler makes this content fit, so rebuild it child by child, wrapping
// what needs a wrapper and dropping what the schema cannot hold at all.
function fitContent(match: ContentMatch, content: Fragment): Fragment {
	let kept = Fragment.empty

	content.forEach(child => {
		const at = match.matchFragment(kept)
		if (at === null) {
			return
		}

		const missing = at.fillBefore(Fragment.from(child))
		if (missing) {
			kept = kept.append(missing).append(Fragment.from(child))
			return
		}

		const wrapping = at.findWrapping(child.type)
		if (wrapping === null) {
			return
		}

		let wrapped: ProseMirrorNode | null = child
		for (let i = wrapping.length - 1; i >= 0 && wrapped !== null; i--) {
			wrapped = wrapping[i].createAndFill(null, Fragment.from(wrapped))
		}
		if (wrapped !== null) {
			kept = kept.append(Fragment.from(wrapped))
		}
	})

	return kept
}

// Repairs can empty a node out, which would leave the slice open past its own depth.
function openDepth(content: Fragment, open: number, fromEnd = false): number {
	let depth = 0
	let node = fromEnd ? content.lastChild : content.firstChild

	while (depth < open && node !== null && !node.isLeaf) {
		depth++
		node = fromEnd ? node.content.lastChild : node.content.firstChild
	}

	return depth
}

/**
 * Plain-text form of a copied slice. ProseMirror's default drops list markers, which
 * turns a copied list into a pile of unrelated lines.
 */
export function serializeSliceAsText(slice: Slice): string {
	return blocksToText(slice.content, '').join('\n\n')
}

function blocksToText(fragment: Fragment, indent: string): string[] {
	const blocks: string[] = []
	fragment.forEach(node => {
		const text = blockToText(node, indent)
		if (text !== '') {
			blocks.push(text)
		}
	})
	return blocks
}

function inlineText(node: ProseMirrorNode): string {
	return node.textBetween(0, node.content.size, '\n', leaf => leaf.type.spec.leafText?.(leaf) ?? '')
}

function itemMarker(list: ProseMirrorNode | null, item: ProseMirrorNode, index: number): string {
	if (list?.type.name === 'orderedList') {
		return `${index}. `
	}
	if (list?.type.name === 'taskList' || item.type.name === 'taskItem') {
		return item.attrs.checked ? '- [x] ' : '- [ ] '
	}
	return '- '
}

function listText(node: ProseMirrorNode, indent: string): string {
	const lines: string[] = []
	let index = Number(node.attrs.start ?? 1)
	node.forEach(item => {
		lines.push(listItemText(item, indent, itemMarker(node, item, index++)))
	})
	return lines.join('\n')
}

function listItemText(item: ProseMirrorNode, indent: string, marker: string): string {
	const childIndent = indent + ' '.repeat(marker.length)
	const parts: string[] = []
	item.forEach(child => {
		const text = blockToText(child, childIndent)
		if (text !== '') {
			parts.push(text)
		}
	})
	if (parts.length === 0) {
		return indent + marker.trimEnd()
	}
	// The first block continues on the marker's line, replacing its own indentation.
	parts[0] = indent + marker + parts[0].slice(childIndent.length)
	return parts.join('\n')
}

function blockToText(node: ProseMirrorNode, indent: string): string {
	const name = node.type.name
	if (name === 'bulletList' || name === 'orderedList' || name === 'taskList') {
		return listText(node, indent)
	}
	if (name === 'listItem' || name === 'taskItem') {
		return listItemText(node, indent, itemMarker(null, node, 1))
	}
	if (node.isTextblock) {
		return inlineText(node).split('\n').map(line => indent + line).join('\n')
	}
	if (node.isLeaf) {
		return indent + (node.type.spec.leafText?.(node) ?? '')
	}
	return blocksToText(node.content, indent).join('\n\n')
}
