from __future__ import annotations

import json
import logging
from pathlib import Path

from PySide6.QtCore import QThreadPool, Qt, Signal
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QPlainTextEdit,
    QInputDialog,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from .file_utils import (
    AVAILABLE_TOKENS,
    DEFAULT_TEMPLATE,
    build_proposed_filename,
    ensure_pdf_extension,
    normalize_template,
    resolve_collision,
    sanitize_filename_component,
    validate_template,
)
from .models import AnalysisResult, AppSettings, ItemStatus, PdfItem
from .openai_client import OpenAIPdfAnalyzer
from .settings_store import load_settings, save_settings
from .workers import AnalysisWorker

logger = logging.getLogger(__name__)


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("PDF Renamer")
        self.resize(1280, 760)
        self.setAcceptDrops(True)

        self.items: dict[str, PdfItem] = {}
        self.thread_pool = QThreadPool.globalInstance()
        self.settings = load_settings()
        self.analyzer: OpenAIPdfAnalyzer | None = None
        self.analyzer_error = ""
        try:
            self.analyzer = OpenAIPdfAnalyzer()
        except Exception as exc:  # noqa: BLE001
            self.analyzer_error = str(exc)
            logger.warning("Analyzer initialization failed: %s", exc)

        self.pdf_list = QListWidget()
        self.pdf_list.setSelectionMode(QAbstractItemView.SingleSelection)
        self.pdf_list.currentItemChanged.connect(self.on_selection_changed)

        self.status_value = QLabel("-")
        self.doc_type_value = QLabel("-")
        self.issuer_value = QLabel("-")
        self.date_value = QLabel("-")
        self.amount_value = QLabel("-")
        self.title_value = QLabel("-")
        self.confidence_value = QLabel("-")
        self.proposed_name_value = QLabel("-")
        self.proposed_name_value.setWordWrap(True)
        self.proposed_name_value.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.proposed_name_value.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        self.proposed_name_value.setMinimumHeight(84)
        self.proposed_name_value.setProperty("role", "filename")
        self.edit_proposed_name_button = QPushButton("候補名を編集")
        self.edit_proposed_name_button.clicked.connect(self.edit_proposed_name)
        self.naming_template_edit = QLineEdit(self.settings.naming_template)
        self.naming_template_edit.setPlaceholderText(DEFAULT_TEMPLATE)
        self.naming_template_hint = QLabel(
            "トークン: " + ", ".join(f"{{{token}}}" for token in AVAILABLE_TOKENS),
        )
        self.naming_template_hint.setProperty("role", "hint")
        self.save_template_button = QPushButton("命名設定を保存")
        self.save_template_button.clicked.connect(self.save_naming_template)
        self.analysis_json = QPlainTextEdit()
        self.analysis_json.setReadOnly(True)

        self.analyze_button = QPushButton("解析")
        self.add_files_button = QPushButton("PDFを追加")
        self.clear_files_button = QPushButton("一覧をクリア")
        self.rename_button = QPushButton("リネーム")
        self.skip_button = QPushButton("スキップ")
        self.retry_button = QPushButton("再解析")

        self.analyze_button.clicked.connect(self.analyze_selected_or_all)
        self.add_files_button.clicked.connect(self.pick_files)
        self.clear_files_button.clicked.connect(self.clear_files)
        self.rename_button.clicked.connect(self.rename_selected)
        self.skip_button.clicked.connect(self.skip_selected)
        self.retry_button.clicked.connect(self.retry_selected)

        self._build_ui()
        self._apply_styles()
        if self.analyzer_error:
            self.analysis_json.setPlainText(self.analyzer_error)

    def _build_ui(self) -> None:
        list_panel = QWidget()
        list_layout = QVBoxLayout(list_panel)
        header_row = QHBoxLayout()
        header_row.addWidget(QLabel("PDF一覧"))
        header_row.addStretch()
        header_row.addWidget(self.add_files_button)
        header_row.addWidget(self.clear_files_button)
        list_layout.addLayout(header_row)
        list_layout.addWidget(QLabel("このウィンドウ全体へ PDF をドラッグ&ドロップできます"))
        list_layout.addWidget(self.pdf_list)

        details_panel = QWidget()
        details_layout = QVBoxLayout(details_panel)
        details_layout.addWidget(QLabel("解析結果"))
        details_layout.addWidget(QLabel("命名ルール"))
        details_layout.addWidget(self.naming_template_edit)
        details_layout.addWidget(self.naming_template_hint)
        details_layout.addWidget(self.save_template_button)

        form = QFormLayout()
        form.addRow("状態", self.status_value)
        form.addRow("文書種別", self.doc_type_value)
        form.addRow("発行元名 / 会社名", self.issuer_value)
        form.addRow("日付", self.date_value)
        form.addRow("金額", self.amount_value)
        form.addRow("タイトル", self.title_value)
        form.addRow("confidence", self.confidence_value)
        details_layout.addLayout(form)
        details_layout.addWidget(QLabel("候補ファイル名"))
        details_layout.addWidget(self.proposed_name_value)
        details_layout.addWidget(self.edit_proposed_name_button)
        details_layout.addWidget(QLabel("AI 返答(JSON)"))
        details_layout.addWidget(self.analysis_json)

        splitter = QSplitter()
        splitter.addWidget(list_panel)
        splitter.addWidget(details_panel)
        splitter.setSizes([500, 780])

        button_row = QHBoxLayout()
        button_row.addWidget(self.analyze_button)
        button_row.addWidget(self.rename_button)
        button_row.addWidget(self.skip_button)
        button_row.addWidget(self.retry_button)

        container = QWidget()
        root_layout = QVBoxLayout(container)
        root_layout.addWidget(splitter)
        root_layout.addLayout(button_row)

        self.setCentralWidget(container)

    def _apply_styles(self) -> None:
        self.setStyleSheet(
            """
            QMainWindow {
                background: #060b14;
            }
            QLabel {
                color: #d7e6ff;
                font-size: 14px;
            }
            QLabel[role="hint"] {
                color: #7da6e8;
                font-size: 12px;
            }
            QListWidget, QPlainTextEdit, QLineEdit {
                background: #0a1220;
                color: #edf4ff;
                border: 1px solid #20324d;
                border-radius: 12px;
                padding: 8px;
                selection-background-color: #1e5eff;
                selection-color: #ffffff;
            }
            QPushButton {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #0f6bff, stop:1 #21b1ff);
                color: white;
                border: none;
                border-radius: 12px;
                padding: 10px 18px;
                min-width: 120px;
                font-weight: 600;
            }
            QPushButton:disabled {
                background: #34445f;
                color: #8ca0c4;
            }
            QPushButton:hover {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #2c86ff, stop:1 #42c6ff);
            }
            QPushButton:pressed {
                background: #0d4fbe;
            }
            QSplitter::handle {
                background: #142238;
                width: 8px;
            }
            QListWidget::item {
                padding: 10px;
                margin: 4px 2px;
                border-radius: 8px;
            }
            QListWidget::item:selected {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #123a86, stop:1 #1760d4);
            }
            QPlainTextEdit, QLineEdit, QListWidget {
                font-size: 13px;
            }
            QLabel[role="filename"] {
                background: #0a1220;
                color: #edf4ff;
                border: 1px solid #20324d;
                border-radius: 12px;
                padding: 10px 12px;
                font-size: 13px;
            }
            QMessageBox {
                background: #08101d;
            }
            """
        )

    def dragEnterEvent(self, event) -> None:  # type: ignore[override]
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            event.ignore()

    def dropEvent(self, event) -> None:  # type: ignore[override]
        paths: list[str] = []
        for url in event.mimeData().urls():
            if url.isLocalFile():
                local_path = Path(url.toLocalFile())
                if local_path.suffix.lower() == ".pdf":
                    paths.append(str(local_path))
        if paths:
            self.add_files(paths)
            event.acceptProposedAction()
        else:
            event.ignore()

    def pick_files(self) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self,
            "PDF を選択",
            "",
            "PDF Files (*.pdf)",
        )
        if paths:
            self.add_files(paths)

    def add_files(self, paths: list[str]) -> None:
        added_any = False
        for raw_path in paths:
            path = Path(raw_path)
            key = str(path.resolve())
            if key in self.items:
                continue
            item = PdfItem(source_path=path, current_path=path)
            self.items[key] = item
            self.pdf_list.addItem(self._list_label(item))
            added_any = True
            logger.info("Added PDF: %s", path)

        if added_any and self.pdf_list.currentRow() == -1:
            self.pdf_list.setCurrentRow(0)

    def clear_files(self) -> None:
        if not self.items:
            return
        self.items.clear()
        self.pdf_list.clear()
        self.update_details(None)
        logger.info("Cleared all registered PDFs")

    def _list_label(self, item: PdfItem) -> str:
        return f"[{item.status.value}] {item.display_name}"

    def _refresh_list(self) -> None:
        current_key = self.current_item_key()
        self.pdf_list.clear()
        for key, item in self.items.items():
            list_item = QListWidgetItem(self._list_label(item))
            list_item.setData(Qt.UserRole, key)
            self.pdf_list.addItem(list_item)

        if current_key:
            for index in range(self.pdf_list.count()):
                list_item = self.pdf_list.item(index)
                if list_item.data(Qt.UserRole) == current_key:
                    self.pdf_list.setCurrentRow(index)
                    break

    def current_item_key(self) -> str | None:
        current = self.pdf_list.currentItem()
        if current and current.data(Qt.UserRole):
            return str(current.data(Qt.UserRole))
        if current:
            row = self.pdf_list.currentRow()
            if row >= 0:
                return list(self.items.keys())[row]
        return None

    def current_pdf_item(self) -> PdfItem | None:
        key = self.current_item_key()
        if not key:
            return None
        return self.items.get(key)

    def on_selection_changed(self) -> None:
        item = self.current_pdf_item()
        self.update_details(item)

    def update_details(self, item: PdfItem | None) -> None:
        if not item:
            for widget in (
                self.status_value,
                self.doc_type_value,
                self.issuer_value,
                self.date_value,
                self.amount_value,
                self.title_value,
                self.confidence_value,
            ):
                widget.setText("-")
            self.proposed_name_value.setText("-")
            self.analysis_json.setPlainText("")
            return

        self.status_value.setText(item.status.value)
        if item.analysis:
            self.doc_type_value.setText(item.analysis.document_type or "-")
            self.issuer_value.setText(item.analysis.issuer_name or "-")
            self.date_value.setText(item.analysis.date or "-")
            self.amount_value.setText(item.analysis.amount or "-")
            self.title_value.setText(item.analysis.title or "-")
            self.confidence_value.setText(f"{item.analysis.confidence:.2f}")
            self.analysis_json.setPlainText(
                json.dumps(item.analysis.to_dict(), ensure_ascii=False, indent=2),
            )
        else:
            self.doc_type_value.setText("-")
            self.issuer_value.setText("-")
            self.date_value.setText("-")
            self.amount_value.setText("-")
            self.title_value.setText("-")
            self.confidence_value.setText("-")
            self.analysis_json.setPlainText(item.error_message)
        self.proposed_name_value.setText(item.proposed_name or "-")

    def analyze_selected_or_all(self) -> None:
        if not self.analyzer:
            QMessageBox.warning(self, "OpenAI API", self.analyzer_error or "OpenAI クライアントを初期化できません。")
            return
        selected = self.current_pdf_item()
        if selected and selected.status not in {ItemStatus.ANALYZING, ItemStatus.RENAMED}:
            self._start_analysis(selected)
            return

        for item in self.items.values():
            if item.status in {ItemStatus.PENDING, ItemStatus.ERROR, ItemStatus.NEEDS_REVIEW, ItemStatus.READY}:
                self._start_analysis(item)

    def _start_analysis(self, item: PdfItem) -> None:
        if not self.analyzer:
            return
        item.status = ItemStatus.ANALYZING
        item.error_message = ""
        self._refresh_list()
        self.update_details(item)

        worker = AnalysisWorker(
            self.analyzer,
            item.current_path,
            self.settings.naming_template,
        )
        worker.signals.result.connect(self.on_analysis_result)
        worker.signals.error.connect(self.on_analysis_error)
        self.thread_pool.start(worker)

    def on_analysis_result(self, path: str, analysis: AnalysisResult, proposed_name: str) -> None:
        item = self.items.get(str(Path(path).resolve()))
        if not item:
            return
        item.analysis = analysis
        item.proposed_name = proposed_name
        item.error_message = ""
        item.status = ItemStatus.READY if analysis.confidence >= 0.8 else ItemStatus.NEEDS_REVIEW
        item.history.append(f"analyzed:{json.dumps(analysis.to_dict(), ensure_ascii=False)}")
        logger.info("Analysis completed for %s", path)
        self._refresh_list()
        if self.current_pdf_item() is item:
            self.update_details(item)

    def on_analysis_error(self, path: str, message: str) -> None:
        item = self.items.get(str(Path(path).resolve()))
        if not item:
            return
        item.status = ItemStatus.ERROR
        item.error_message = message
        item.history.append(f"error:{message}")
        logger.error("Analysis failed for %s: %s", path, message)
        self._refresh_list()
        if self.current_pdf_item() is item:
            self.update_details(item)

    def edit_proposed_name(self) -> None:
        item = self.current_pdf_item()
        if not item:
            return
        current_name = item.proposed_name or item.current_path.name
        edited_text, accepted = QInputDialog.getText(
            self,
            "候補ファイル名を編集",
            "新しい候補ファイル名",
            text=current_name,
        )
        if not accepted:
            return
        edited = sanitize_filename_component(edited_text, "renamed") or "renamed"
        item.proposed_name = ensure_pdf_extension(edited)
        self.proposed_name_value.setText(item.proposed_name)
        self._refresh_list()

    def save_naming_template(self) -> None:
        template = normalize_template(self.naming_template_edit.text())
        valid, message = validate_template(template)
        if not valid:
            QMessageBox.warning(self, "命名ルール", message)
            return

        self.settings = AppSettings(naming_template=template)
        save_settings(self.settings)
        logger.info("Saved naming template: %s", template)

        for item in self.items.values():
            if item.analysis:
                item.proposed_name = build_proposed_filename(
                    item.analysis,
                    self.settings.naming_template,
                )

        self.naming_template_edit.setText(template)
        self._refresh_list()
        self.update_details(self.current_pdf_item())
        QMessageBox.information(self, "命名ルール", "命名設定を保存しました。")

    def rename_selected(self) -> None:
        item = self.current_pdf_item()
        if not item:
            QMessageBox.information(self, "情報", "対象PDFを選択してください。")
            return
        if item.status == ItemStatus.RENAMED:
            QMessageBox.information(self, "情報", "このPDFはすでにリネーム済みです。")
            return
        if not item.proposed_name:
            QMessageBox.warning(self, "警告", "候補ファイル名がありません。先に解析してください。")
            return

        normalized_name = ensure_pdf_extension(item.proposed_name)
        same_name_target = item.current_path.parent / normalized_name
        target = same_name_target
        if same_name_target != item.current_path:
            target = resolve_collision(item.current_path.parent, normalized_name)
        source = item.current_path
        source.rename(target)
        item.current_path = target
        item.status = ItemStatus.RENAMED
        item.history.append(f"renamed:{target.name}")
        logger.info("Renamed file: %s -> %s", source, target)
        self._refresh_list()
        self.update_details(item)

    def skip_selected(self) -> None:
        item = self.current_pdf_item()
        if not item:
            return
        item.status = ItemStatus.SKIPPED
        item.skipped = True
        item.history.append("skipped")
        logger.info("Skipped file: %s", item.current_path)
        self._refresh_list()
        self.update_details(item)

    def retry_selected(self) -> None:
        item = self.current_pdf_item()
        if not item:
            return
        self._start_analysis(item)


def run_app() -> int:
    app = QApplication.instance() or QApplication([])
    window = MainWindow()
    window.show()
    return app.exec()
