import type { Destination } from '../types.ts'
import {
  getAllDestinations,
  putDestination,
  deleteDestination,
  generateId,
} from '../store/destinations.ts'
import { searchPlaces, type GeocodeResult } from '../api/geocode.ts'
import { refreshDestinations } from '../glasses/nav.ts'

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderList(listEl: HTMLUListElement): void {
  const all = getAllDestinations()
  if (all.length === 0) {
    listEl.innerHTML = '<li class="empty">目的地がありません</li>'
    return
  }
  listEl.innerHTML = all.map(dest => `
    <li class="dest-row" data-id="${escapeHtml(dest.id)}">
      <span class="dest-info">
        <strong>${escapeHtml(dest.name)}</strong>
        <small>${dest.lat.toFixed(4)}, ${dest.lng.toFixed(4)}</small>
      </span>
      <span class="dest-actions">
        <button class="btn-edit" data-id="${escapeHtml(dest.id)}">編集</button>
        <button class="btn-delete" data-id="${escapeHtml(dest.id)}">削除</button>
      </span>
    </li>`).join('')
}

export function mountPhoneUI(root: HTMLElement): void {
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { background: #111; color: #e5e5e5; font-family: system-ui, sans-serif; }
      #app { max-width: 600px; margin: 0 auto; padding: 16px; display: block; }
      h1 { font-size: 20px; margin-bottom: 16px; color: #7fb8ff; }
      h2 { font-size: 16px; margin-bottom: 12px; }
      .card { background: #1e1e1e; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
      label { display: block; font-size: 13px; color: #aaa; margin-bottom: 4px; margin-top: 10px; }
      label:first-of-type { margin-top: 0; }
      input { width: 100%; background: #2a2a2a; border: 1px solid #444; color: #e5e5e5;
        border-radius: 4px; padding: 8px; font-size: 14px; }
      .row { display: flex; gap: 8px; }
      .row input { flex: 1; }
      button { cursor: pointer; border: none; border-radius: 4px; padding: 8px 14px;
        font-size: 14px; }
      #btn-search { background: #2a4a6a; color: #7fb8ff; white-space: nowrap; }
      #btn-submit { background: #7fb8ff; color: #111; width: 100%; margin-top: 14px;
        font-weight: bold; }
      #btn-cancel { background: #444; color: #e5e5e5; width: 100%; margin-top: 6px; display: none; }
      #search-status { font-size: 12px; color: #888; margin-top: 6px; min-height: 16px; }
      #search-results { list-style: none; margin-top: 6px; }
      #search-results li { padding: 8px; border: 1px solid #2a2a2a; border-radius: 4px;
        margin-bottom: 4px; font-size: 13px; cursor: pointer; }
      #search-results li:active { background: #2a4a6a; }
      ul { list-style: none; }
      .dest-row { display: flex; align-items: center; gap: 8px; padding: 10px 0;
        border-bottom: 1px solid #2a2a2a; }
      .dest-info { flex: 1; display: flex; flex-direction: column; gap: 2px; }
      .dest-info strong { font-size: 14px; }
      .dest-info small { font-size: 12px; color: #888; }
      .dest-actions { display: flex; gap: 6px; }
      .btn-edit { background: #2a4a6a; color: #7fb8ff; }
      .btn-delete { background: #4a2a2a; color: #ff9090; }
      .empty { color: #555; padding: 16px 0; text-align: center; }
    </style>
    <h1>NavigatEven</h1>
    <div class="card">
      <h2 id="form-title">目的地を追加</h2>
      <input type="hidden" id="edit-id" value="" />
      <label>場所を検索</label>
      <div class="row">
        <input type="text" id="inp-query" placeholder="渋谷駅" />
        <button id="btn-search">検索</button>
      </div>
      <div id="search-status"></div>
      <ul id="search-results"></ul>
      <label>名前</label>
      <input type="text" id="inp-name" placeholder="職場" />
      <label>緯度 / 経度（検索で自動入力・手入力も可）</label>
      <div class="row">
        <input type="text" id="inp-lat" placeholder="35.6580" inputmode="decimal" />
        <input type="text" id="inp-lng" placeholder="139.7016" inputmode="decimal" />
      </div>
      <button id="btn-submit">追加</button>
      <button id="btn-cancel">キャンセル</button>
    </div>
    <div class="card">
      <h2>目的地一覧</h2>
      <ul id="dest-list"></ul>
    </div>
  `

  const listEl = root.querySelector<HTMLUListElement>('#dest-list')!
  const editIdEl = root.querySelector<HTMLInputElement>('#edit-id')!
  const queryEl = root.querySelector<HTMLInputElement>('#inp-query')!
  const searchBtn = root.querySelector<HTMLButtonElement>('#btn-search')!
  const searchStatusEl = root.querySelector<HTMLDivElement>('#search-status')!
  const searchResultsEl = root.querySelector<HTMLUListElement>('#search-results')!
  const nameEl = root.querySelector<HTMLInputElement>('#inp-name')!
  const latEl = root.querySelector<HTMLInputElement>('#inp-lat')!
  const lngEl = root.querySelector<HTMLInputElement>('#inp-lng')!
  const submitBtn = root.querySelector<HTMLButtonElement>('#btn-submit')!
  const cancelBtn = root.querySelector<HTMLButtonElement>('#btn-cancel')!
  const formTitle = root.querySelector<HTMLHeadingElement>('#form-title')!

  let searchResults: GeocodeResult[] = []
  let searching = false

  renderList(listEl)

  function clearForm(): void {
    editIdEl.value = ''
    queryEl.value = ''
    nameEl.value = ''
    latEl.value = ''
    lngEl.value = ''
    searchResults = []
    searchResultsEl.innerHTML = ''
    searchStatusEl.textContent = ''
    submitBtn.textContent = '追加'
    formTitle.textContent = '目的地を追加'
    cancelBtn.style.display = 'none'
  }

  searchBtn.addEventListener('click', async () => {
    const query = queryEl.value.trim()
    if (!query || searching) return
    searching = true
    searchBtn.disabled = true
    searchStatusEl.textContent = '検索中...'
    searchResultsEl.innerHTML = ''
    try {
      searchResults = await searchPlaces(query)
      if (searchResults.length === 0) {
        searchStatusEl.textContent = '見つかりませんでした。緯度経度の手入力もできます'
      } else {
        searchStatusEl.textContent = '候補をタップして選択:'
        searchResultsEl.innerHTML = searchResults.map((r, i) =>
          `<li data-index="${i}">${escapeHtml(r.displayName || r.name)}</li>`,
        ).join('')
      }
    } catch {
      searchStatusEl.textContent = '検索に失敗しました。通信状態を確認してください'
    } finally {
      searching = false
      searchBtn.disabled = false
    }
  })

  searchResultsEl.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('li')
    if (!li) return
    const result = searchResults[Number(li.dataset['index'])]
    if (!result) return
    latEl.value = String(result.lat)
    lngEl.value = String(result.lng)
    if (!nameEl.value.trim()) nameEl.value = result.name
    searchStatusEl.textContent = `選択: ${result.name}`
    searchResultsEl.innerHTML = ''
  })

  submitBtn.addEventListener('click', async () => {
    const name = nameEl.value.trim()
    const lat = Number(latEl.value.trim())
    const lng = Number(lngEl.value.trim())
    if (!name) {
      alert('名前は必須です')
      return
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      alert('緯度経度が正しくありません。場所を検索するか数値を入力してください')
      return
    }

    const dest: Destination = {
      id: editIdEl.value || generateId(),
      name,
      lat,
      lng,
    }
    putDestination(dest)
    await refreshDestinations()
    clearForm()
    renderList(listEl)
  })

  cancelBtn.addEventListener('click', () => { clearForm() })

  listEl.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement
    const id = target.dataset['id']
    if (!id) return

    if (target.classList.contains('btn-delete')) {
      if (!confirm('この目的地を削除しますか？')) return
      deleteDestination(id)
      await refreshDestinations()
      renderList(listEl)
      return
    }

    if (target.classList.contains('btn-edit')) {
      const dest = getAllDestinations().find(d => d.id === id)
      if (!dest) return
      editIdEl.value = dest.id
      nameEl.value = dest.name
      latEl.value = String(dest.lat)
      lngEl.value = String(dest.lng)
      submitBtn.textContent = '更新'
      formTitle.textContent = '目的地を編集'
      cancelBtn.style.display = 'block'
      root.scrollTo({ top: 0, behavior: 'smooth' })
    }
  })
}
