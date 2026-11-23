<script>
  import PageShell from '../layout/page-shell.svelte';
  import { loadCredits } from '../lib/catalog.js';

  /** @type {{credits: import('../../contracts/catalog.js').Credit[] | null, failed: boolean}} */
  const loaded = (() => {
    try {
      return { credits: loadCredits(), failed: false };
    } catch (err) {
      console.error('Failed to read the credits', err);
      return { credits: null, failed: true };
    }
  })();
</script>

<PageShell title="Ghi công">
  <div class="space-y-6 text-slate-200" data-testid="page-credits">
    <section>
      <h2 class="mb-2 text-xl font-semibold">Dữ liệu bản đồ</h2>
      <p data-testid="credits-osm">
        Bản đồ mô phỏng dựng từ dữ liệu
        <a class="text-sky-300 underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
          © OpenStreetMap contributors
        </a>, cung cấp theo giấy phép Open Database License (ODbL).
      </p>
    </section>

    <section>
      <h2 class="mb-2 text-xl font-semibold">Mô hình và hình ảnh</h2>
      {#if loaded.failed}
        <p class="text-rose-300">Không đọc được danh sách ghi công.</p>
      {:else if !loaded.credits || loaded.credits.length === 0}
        <p class="text-slate-400">Chưa có tài nguyên cần ghi công.</p>
      {:else}
        <ul class="space-y-2" data-testid="credits-list">
          {#each loaded.credits as credit (credit.file)}
            <li class="rounded-lg border border-slate-800 p-3 text-sm">
              {#if credit.creditLine}
                <p>{credit.creditLine}</p>
              {:else}
                <p>
                  <a class="text-sky-300 underline" href={credit.sourceUrl} target="_blank" rel="noopener noreferrer">“{credit.title}”</a>
                  — {credit.ownWork ? 'do dự án tự vẽ' : credit.author},
                  <a class="text-sky-300 underline" href={credit.licenceUrl} target="_blank" rel="noopener noreferrer">{credit.licence}</a>
                </p>
              {/if}
              <p class="text-xs text-slate-500">{credit.file}</p>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h2 class="mb-2 text-xl font-semibold">Mã nguồn</h2>
      <p>
        Mã nguồn của trò chơi phát hành theo giấy phép
        <a class="text-sky-300 underline" href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noopener noreferrer">Apache-2.0</a>.
      </p>
    </section>
  </div>
</PageShell>
