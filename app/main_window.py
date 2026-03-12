from __future__ import annotations

import json
import logging
from pathlib import Path

from PySide6.QtCore import QThreadPool, Qt, QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGridLayout,
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
        self.resize(1120, 700)
        self.setAcceptDrops(True)

        self.items: dict[str, PdfItem] = {}
        self.thread_pool = QThreadPool.globalInstance()
        self.settings = load_settings()
        self.analyzer: OpenAIPdfAnalyzer | None = None
        self.analyzer_error = ""
        try:
            self.analyzer = OpenAIPdfAnalyzer(model=self.settings.openai_model)
        except Exception as exc:  # noqa: BLE001
            self.analyzer_error = str(exc)
            logger.warning("Analyzer initialization failed: %s", exc)

        self.pdf_list = QListWidget()
        self.pdf_list.setSelectionMode(QAbstractItemView.SingleSelection)
        self.pdf_list.currentItemChanged.connect(self.on_selection_changed)
        self.pdf_list.itemChanged.connect(self.on_list_item_changed)
        self.pdf_list.itemDoubleClicked.connect(self.open_list_item_pdf)
        self._updating_check_state = False
        self.select_all_checkbox = QCheckBox("")
        self.select_all_checkbox.setTristate(False)
        self.select_all_checkbox.stateChanged.connect(self.on_select_all_changed)

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
        self.edit_proposed_name_button = QPushButton("編集")
        self.edit_proposed_name_button.setProperty("role", "tiny")
        self.edit_proposed_name_button.clicked.connect(self.edit_proposed_name)
        self.model_combo = QComboBox()
        self.model_combo.setEditable(True)
        self.model_combo.addItem(self.settings.openai_model)
        self.model_combo.setCurrentText(self.settings.openai_model)
        self.model_combo.setInsertPolicy(QComboBox.NoInsert)
        self.naming_template_edit = QLineEdit(self.settings.naming_template)
        self.naming_template_edit.setPlaceholderText(DEFAULT_TEMPLATE)
        self.naming_template_hint = QLabel(
            "トークン: " + ", ".join(f"{{{token}}}" for token in AVAILABLE_TOKENS),
        )
        self.naming_template_hint.setProperty("role", "hint")
        self.save_template_button = QPushButton("命名設定を保存")
        self.save_template_button.setProperty("role", "subtle")
        self.save_template_button.clicked.connect(self.save_naming_template)
        self.load_models_button = QPushButton("一覧取得")
        self.load_models_button.setProperty("role", "subtle")
        self.load_models_button.clicked.connect(self.load_available_models)
        self.save_model_button = QPushButton("モデル設定を保存")
        self.save_model_button.setProperty("role", "subtle")
        self.save_model_button.clicked.connect(self.save_model_setting)
        self.analysis_json = QPlainTextEdit()
        self.analysis_json.setReadOnly(True)
        for value_label in (
            self.status_value,
            self.doc_type_value,
            self.issuer_value,
            self.date_value,
            self.amount_value,
            self.title_value,
            self.confidence_value,
        ):
            value_label.setAlignment(Qt.AlignLeft | Qt.AlignVCenter)

        self.analyze_button = QPushButton("解析")
        self.add_files_button = QPushButton("PDFを追加")
        self.clear_files_button = QPushButton("一覧をクリア")
        self.rename_button = QPushButton("リネーム")
        self.skip_button = QPushButton("スキップ")
        self.retry_button = QPushButton("再解析")
        self.analyze_button.setProperty("role", "analyze")
        self.retry_button.setProperty("role", "retry")
        self.rename_button.setProperty("role", "rename")
        self.skip_button.setProperty("role", "skip")
        self.add_files_button.setProperty("role", "subtle")
        self.clear_files_button.setProperty("role", "subtle")

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
        list_layout.setSpacing(6)
        header_row = QHBoxLayout()
        header_row.addWidget(QLabel("PDF一覧"))
        header_row.addStretch()
        header_row.addWidget(self.add_files_button)
        header_row.addWidget(self.clear_files_button)
        list_layout.addLayout(header_row)
        list_layout.addWidget(QLabel("このウィンドウ全体へ PDF をドラッグ&ドロップできます"))
        list_container = QFrame()
        list_container.setProperty("role", "listContainer")
        list_container_layout = QVBoxLayout(list_container)
        list_container_layout.setContentsMargins(0, 0, 0, 0)
        list_container_layout.setSpacing(0)
        list_header_frame = QFrame()
        list_header_frame.setProperty("role", "listHeader")
        list_header_row = QHBoxLayout()
        list_header_row.setContentsMargins(14, 10, 14, 10)
        list_header_row.setSpacing(10)
        self.select_all_checkbox.setFixedWidth(28)
        filename_header = QLabel("ファイル名")
        filename_header.setProperty("role", "hint")
        list_header_row.addWidget(self.select_all_checkbox)
        list_header_row.addWidget(filename_header)
        list_header_row.addStretch()
        list_header_frame.setLayout(list_header_row)
        self.pdf_list.setProperty("role", "listBody")
        list_container_layout.addWidget(list_header_frame)
        list_container_layout.addWidget(self.pdf_list)
        list_layout.addWidget(list_container)

        details_panel = QWidget()
        details_layout = QVBoxLayout(details_panel)
        details_layout.addWidget(QLabel("解析結果"))
        details_layout.addWidget(QLabel("使用モデル"))
        model_row = QHBoxLayout()
        model_row.addWidget(self.model_combo)
        model_row.addWidget(self.load_models_button)
        model_row.addWidget(self.save_model_button)
        details_layout.addLayout(model_row)
        details_layout.addWidget(QLabel("命名ルール"))
        details_layout.addWidget(self.naming_template_edit)
        template_meta_row = QHBoxLayout()
        template_meta_row.addWidget(self.naming_template_hint)
        template_meta_row.addStretch()
        template_meta_row.addWidget(self.save_template_button)
        details_layout.addLayout(template_meta_row)

        form = QFormLayout()
        form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)
        form.setFormAlignment(Qt.AlignTop | Qt.AlignLeft)
        form.setHorizontalSpacing(16)
        form.setVerticalSpacing(10)
        form.addRow("状態", self.status_value)
        form.addRow("文書種別", self.doc_type_value)
        form.addRow("発行元名 / 会社名", self.issuer_value)
        form.addRow("日付", self.date_value)
        form.addRow("金額", self.amount_value)
        form.addRow("タイトル", self.title_value)
        form.addRow("confidence", self.confidence_value)
        details_layout.addLayout(form)
        proposed_header_row = QHBoxLayout()
        proposed_header_row.addWidget(QLabel("候補ファイル名"))
        proposed_header_row.addWidget(self.edit_proposed_name_button)
        proposed_header_row.addStretch()
        details_layout.addLayout(proposed_header_row)
        details_layout.addWidget(self.proposed_name_value)
        details_layout.addWidget(QLabel("操作"))
        action_grid = QGridLayout()
        action_grid.setHorizontalSpacing(10)
        action_grid.setVerticalSpacing(10)
        action_grid.addWidget(self.analyze_button, 0, 0)
        action_grid.addWidget(self.retry_button, 0, 1)
        action_grid.addWidget(self.rename_button, 1, 0)
        action_grid.addWidget(self.skip_button, 1, 1)
        details_layout.addLayout(action_grid)
        details_layout.addWidget(QLabel("AI 返答(JSON)"))
        details_layout.addWidget(self.analysis_json)

        splitter = QSplitter()
        splitter.addWidget(list_panel)
        splitter.addWidget(details_panel)
        splitter.setSizes([500, 780])

        container = QWidget()
        root_layout = QVBoxLayout(container)
        root_layout.addWidget(splitter)

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
                padding-top: 12px;
                padding-bottom: 8px;
            }
            QSplitter::handle {
                background: #142238;
                width: 8px;
            }
            QListWidget::item {
                padding: 10px 12px;
                margin: 2px 6px;
                border-radius: 8px;
            }
            QListWidget::item:selected {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #123a86, stop:1 #1760d4);
            }
            QPlainTextEdit, QLineEdit, QListWidget {
                font-size: 13px;
            }
            QPushButton[role="analyze"] {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #0f6bff, stop:1 #21b1ff);
            }
            QPushButton[role="retry"] {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #355c9a, stop:1 #4c7bc3);
            }
            QPushButton[role="rename"] {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #0aa36c, stop:1 #1fd39b);
            }
            QPushButton[role="skip"] {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #6b7280, stop:1 #8a94a6);
            }
            QPushButton[role="subtle"] {
                min-width: 0px;
                padding: 8px 12px;
                font-size: 12px;
                border-radius: 10px;
            }
            QPushButton[role="tiny"] {
                min-width: 0px;
                padding: 4px 8px;
                font-size: 11px;
                border-radius: 8px;
            }
            QPushButton[role="subtle"] {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #123a86, stop:1 #1760d4);
            }
            QLabel[role="filename"] {
                background: #0a1220;
                color: #edf4ff;
                border: 1px solid #20324d;
                border-radius: 12px;
                padding: 10px 12px;
                font-size: 13px;
            }
            QFrame[role="listContainer"] {
                background: #0a1220;
                border: 1px solid #20324d;
                border-radius: 12px;
            }
            QFrame[role="listHeader"] {
                background: rgba(255, 255, 255, 0.02);
                border: none;
                border-bottom: 1px solid #20324d;
            }
            QListWidget[role="listBody"] {
                border: none;
                border-top-left-radius: 0px;
                border-top-right-radius: 0px;
                background: transparent;
                padding: 4px 0px 6px 0px;
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
            list_item = QListWidgetItem(self._list_label(item))
            list_item.setData(Qt.UserRole, key)
            list_item.setFlags(
                list_item.flags() | Qt.ItemIsUserCheckable | Qt.ItemIsEnabled | Qt.ItemIsSelectable,
            )
            list_item.setCheckState(Qt.Unchecked)
            self.pdf_list.addItem(list_item)
            added_any = True
            logger.info("Added PDF: %s", path)

        if added_any and self.pdf_list.currentRow() == -1:
            self.pdf_list.setCurrentRow(0)
        self._sync_select_all_checkbox()

    def clear_files(self) -> None:
        if not self.items:
            return
        self.items.clear()
        self.pdf_list.clear()
        self.select_all_checkbox.setCheckState(Qt.Unchecked)
        self.update_details(None)
        logger.info("Cleared all registered PDFs")

    def _list_label(self, item: PdfItem) -> str:
        return f"[{item.status.value}] {item.display_name}"

    def _refresh_list(self) -> None:
        current_key = self.current_item_key()
        self._updating_check_state = True
        self.pdf_list.clear()
        for key, item in self.items.items():
            list_item = QListWidgetItem(self._list_label(item))
            list_item.setData(Qt.UserRole, key)
            list_item.setFlags(
                list_item.flags() | Qt.ItemIsUserCheckable | Qt.ItemIsEnabled | Qt.ItemIsSelectable,
            )
            list_item.setCheckState(Qt.Checked if item.checked else Qt.Unchecked)
            self.pdf_list.addItem(list_item)
        self._updating_check_state = False

        if current_key:
            for index in range(self.pdf_list.count()):
                list_item = self.pdf_list.item(index)
                if list_item.data(Qt.UserRole) == current_key:
                    self.pdf_list.setCurrentRow(index)
                    break
        self._sync_select_all_checkbox()

    def on_list_item_changed(self, list_item: QListWidgetItem) -> None:
        if self._updating_check_state:
            return
        key = list_item.data(Qt.UserRole)
        if not key:
            return
        item = self.items.get(str(key))
        if not item:
            return
        item.checked = list_item.checkState() == Qt.CheckState.Checked
        self._sync_select_all_checkbox()

    def on_select_all_changed(self, state: int) -> None:
        if self._updating_check_state:
            return
        checked = Qt.CheckState(state) == Qt.CheckState.Checked
        self._updating_check_state = True
        for index in range(self.pdf_list.count()):
            list_item = self.pdf_list.item(index)
            if list_item is None:
                continue
            list_item.setCheckState(
                Qt.CheckState.Checked if checked else Qt.CheckState.Unchecked,
            )
            key = list_item.data(Qt.UserRole)
            if key and str(key) in self.items:
                self.items[str(key)].checked = checked
        self._updating_check_state = False
        self._sync_select_all_checkbox()

    def _sync_select_all_checkbox(self) -> None:
        total = len(self.items)
        checked_count = sum(1 for item in self.items.values() if item.checked)
        self._updating_check_state = True
        self.select_all_checkbox.blockSignals(True)
        if total > 0 and checked_count == total:
            self.select_all_checkbox.setCheckState(Qt.CheckState.Checked)
        else:
            self.select_all_checkbox.setCheckState(Qt.CheckState.Unchecked)
        self.select_all_checkbox.blockSignals(False)
        self._updating_check_state = False

    def checked_items(self) -> list[PdfItem]:
        return [item for item in self.items.values() if item.checked]

    def target_items(self) -> list[PdfItem]:
        checked = self.checked_items()
        if checked:
            return checked
        current = self.current_pdf_item()
        return [current] if current else []

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

    def open_list_item_pdf(self, list_item: QListWidgetItem) -> None:
        key = list_item.data(Qt.UserRole)
        if not key:
            return
        item = self.items.get(str(key))
        if not item:
            return
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(item.current_path)))

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
        targets = self.target_items()
        if not targets:
            targets = list(self.items.values())
        for item in targets:
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

        self.settings = AppSettings(
            naming_template=template,
            openai_model=self.model_combo.currentText().strip() or self.settings.openai_model,
        )
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

    def load_available_models(self) -> None:
        if not self.analyzer:
            QMessageBox.warning(self, "使用モデル", self.analyzer_error or "OpenAI クライアントを初期化できません。")
            return
        try:
            current_text = self.model_combo.currentText().strip()
            model_ids = self.analyzer.list_models()
        except Exception as exc:  # noqa: BLE001
            logger.error("Failed to load models: %s", exc)
            QMessageBox.warning(self, "使用モデル", f"モデル一覧の取得に失敗しました。\n{exc}")
            return

        self.model_combo.clear()
        for model_id in model_ids:
            self.model_combo.addItem(model_id)
        if current_text:
            index = self.model_combo.findText(current_text)
            if index >= 0:
                self.model_combo.setCurrentIndex(index)
            else:
                self.model_combo.setEditText(current_text)
        logger.info("Loaded %s models from OpenAI API", len(model_ids))

    def save_model_setting(self) -> None:
        model_name = self.model_combo.currentText().strip()
        if not model_name:
            QMessageBox.warning(self, "使用モデル", "モデル名を入力してください。")
            return

        self.settings = AppSettings(
            naming_template=self.settings.naming_template,
            openai_model=model_name,
        )
        save_settings(self.settings)
        if self.analyzer:
            self.analyzer.set_model(model_name)
        logger.info("Saved OpenAI model: %s", model_name)
        QMessageBox.information(self, "使用モデル", "モデル設定を保存しました。")

    def rename_selected(self) -> None:
        targets = self.target_items()
        if not targets:
            QMessageBox.information(self, "情報", "対象PDFにチェックを入れるか選択してください。")
            return
        renamed_any = False
        for item in targets:
            if item.status == ItemStatus.RENAMED or not item.proposed_name:
                continue
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
            renamed_any = True
        if not renamed_any:
            QMessageBox.warning(self, "警告", "リネーム可能なPDFがありません。先に解析してください。")
            return
        self._refresh_list()
        self.update_details(self.current_pdf_item())

    def skip_selected(self) -> None:
        targets = self.target_items()
        if not targets:
            return
        for item in targets:
            item.status = ItemStatus.SKIPPED
            item.skipped = True
            item.history.append("skipped")
            logger.info("Skipped file: %s", item.current_path)
        self._refresh_list()
        self.update_details(self.current_pdf_item())

    def retry_selected(self) -> None:
        targets = self.target_items()
        if not targets:
            return
        for item in targets:
            self._start_analysis(item)


def run_app() -> int:
    app = QApplication.instance() or QApplication([])
    window = MainWindow()
    window.show()
    return app.exec()
