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

  // Third-party code shipped in the bundle. The full licence texts are emitted at build time
  // (build.license in vite.config.js); the production build only, not the dev server.
  const LIBRARIES = Object.freeze([
    { name: 'three.js', licence: 'MIT', url: 'https://github.com/mrdoob/three.js' },
    { name: 'Svelte', licence: 'MIT', url: 'https://github.com/sveltejs/svelte' },
    { name: 'clsx', licence: 'MIT', url: 'https://github.com/lukeed/clsx' },
    { name: 'Rapier (@dimforge/rapier3d-compat)', licence: 'Apache-2.0', url: 'https://github.com/dimforge/rapier.js' },
  ]);
</script>

<PageShell title="Ghi công">
  <div class="space-y-6 text-stone-800" data-testid="page-credits">
    <section>
      <h2 class="mb-2 text-xl font-semibold">Dữ liệu bản đồ</h2>
      <p data-testid="credits-osm">
        Bản đồ mô phỏng dựng từ dữ liệu
        <a class="text-police-700 underline hover:text-police-900" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
          © OpenStreetMap contributors
        </a>, cung cấp theo giấy phép Open Database License (ODbL).
      </p>
      <p class="mt-2 text-sm text-stone-600">
        Các tệp dữ liệu bản đồ dựng từ OpenStreetMap mà trò chơi tải về (thư mục <code>maps/</code>) là cơ sở dữ liệu phái sinh,
        phát hành theo
        <a class="text-police-700 underline hover:text-police-900" href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener noreferrer">ODbL 1.0</a>.
      </p>
    </section>

    <section>
      <h2 class="mb-2 text-xl font-semibold">Mô hình và hình ảnh</h2>
      {#if loaded.failed}
        <p class="text-kepi-600">Không đọc được danh sách ghi công.</p>
      {:else if !loaded.credits || loaded.credits.length === 0}
        <p class="text-stone-600">Chưa có tài nguyên cần ghi công.</p>
      {:else}
        <ul class="space-y-2" data-testid="credits-list">
          {#each loaded.credits as credit (credit.file)}
            <li class="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm">
              {#if credit.creditLine}
                <p>{credit.creditLine}</p>
              {:else}
                <p>
                  <a class="text-police-700 underline hover:text-police-900" href={credit.sourceUrl} target="_blank" rel="noopener noreferrer">“{credit.title}”</a>
                  — {credit.ownWork ? 'do dự án tự vẽ' : credit.author},
                  <a class="text-police-700 underline hover:text-police-900" href={credit.licenceUrl} target="_blank" rel="noopener noreferrer">{credit.licence}</a>
                </p>
              {/if}
              <p class="text-xs text-stone-600">{credit.file}</p>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h2 class="mb-2 text-xl font-semibold">Thư viện</h2>
      <ul class="list-disc space-y-1 pl-5" data-testid="credits-libraries">
        {#each LIBRARIES as lib (lib.name)}
          <li>
            <a class="text-police-700 underline hover:text-police-900" href={lib.url} target="_blank" rel="noopener noreferrer">{lib.name}</a> — {lib.licence}
          </li>
        {/each}
      </ul>
      <p class="mt-2 text-sm text-stone-600">
        Toàn văn giấy phép của các thư viện đi kèm bản dựng:
        <a class="text-police-700 underline hover:text-police-900" href={`${import.meta.env.BASE_URL}third-party-licenses.md`} target="_blank" rel="noopener">third-party-licenses.md</a>.
      </p>
    </section>

    <section>
      <h2 class="mb-2 text-xl font-semibold">Mã nguồn</h2>
      <p>
        Mã nguồn của trò chơi phát hành theo giấy phép
        <a class="text-police-700 underline hover:text-police-900" href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noopener noreferrer">Apache-2.0</a>.
      </p>
    </section>
  </div>
</PageShell>
