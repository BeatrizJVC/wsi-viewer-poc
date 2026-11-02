const SELECTOR_ID = "wsi-slide-selector";

function getSeriesLabel(series, index) {
  const description =
    series?.description?.trim();

  if (description) {
    return description;
  }

  const modality =
    series?.modality?.code ??
    series?.modality?.display;

  if (modality) {
    return `Lámina ${index + 1} · ${modality}`;
  }

  return `Lámina ${index + 1}`;
}

export function renderSlideSelector({
  imagingStudy,
  activeSeriesUID,
}) {
  document
    .getElementById(SELECTOR_ID)
    ?.remove();

  const series =
    (imagingStudy?.series ?? [])
      .filter((item) => item?.uid);

  if (series.length <= 1) {
    return;
  }

  const nav =
    document.getElementById("viewer-nav");

  if (!nav) {
    console.warn(
      "Selector de láminas: #viewer-nav no encontrado."
    );
    return;
  }

  const wrapper =
    document.createElement("div");

  wrapper.id = SELECTOR_ID;
  wrapper.className =
    "wsi-slide-selector";

  const label =
    document.createElement("label");

  label.htmlFor =
    "wsi-slide-select";
  label.textContent =
    "Lámina";

  const select =
    document.createElement("select");

  select.id =
    "wsi-slide-select";
  select.className =
    "wsi-slide-selector__select";

  series.forEach((item, index) => {
    const option =
      document.createElement("option");

    option.value = item.uid;
    option.textContent =
      getSeriesLabel(item, index);

    if (
      item.uid === activeSeriesUID
    ) {
      option.selected = true;
    }

    select.appendChild(option);
  });

  select.addEventListener(
    "change",
    () => {
      const url =
        new URL(window.location.href);

      url.searchParams.set(
        "seriesUID",
        select.value
      );

      window.location.href =
        url.toString();
    }
  );

  const count =
    document.createElement("span");

  count.className =
    "wsi-slide-selector__count";

  const currentIndex =
    Math.max(
      0,
      series.findIndex(
        (item) =>
          item.uid === activeSeriesUID
      )
    );

  count.textContent =
    `${currentIndex + 1} / ${series.length}`;

  wrapper.append(
    label,
    select,
    count
  );

  nav.appendChild(wrapper);
}
