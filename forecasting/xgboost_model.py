"""
XGBoost time-series forecasting model for retail sales by category.
Uses walk-forward validation to produce realistic out-of-sample MAPE estimates.
Outputs predictions + prediction intervals via quantile regression.
"""

import logging
import pickle
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import mean_absolute_percentage_error
from sklearn.preprocessing import StandardScaler

logger = logging.getLogger(__name__)

MODEL_DIR = Path("data/models")

# Columns to exclude from features (target, date identifiers)
NON_FEATURE_COLS = {
    "period", "year_month", "target",
    "date_added", "due_date",
}


def _get_feature_cols(df: pd.DataFrame) -> list[str]:
    return [c for c in df.columns if c not in NON_FEATURE_COLS and df[c].dtype != object]


class RetailForecaster:
    def __init__(self, category: str, n_estimators: int = 400, max_depth: int = 5):
        self.category = category
        self.n_estimators = n_estimators
        self.max_depth = max_depth
        self.model = None
        self.scaler = StandardScaler()
        self.feature_cols: list[str] = []
        self.train_mape: float | None = None
        self.cv_mape: float | None = None

    def _build_model(self, objective: str = "reg:squarederror") -> xgb.XGBRegressor:
        return xgb.XGBRegressor(
            n_estimators=self.n_estimators,
            max_depth=self.max_depth,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            min_child_weight=3,
            reg_alpha=0.1,
            reg_lambda=1.0,
            objective=objective,
            random_state=42,
            n_jobs=-1,
            verbosity=0,
        )

    def fit(self, df: pd.DataFrame, test_size: int = 12) -> dict:
        self.feature_cols = _get_feature_cols(df)
        X = df[self.feature_cols].values
        y = df["target"].values

        # Train/test split (last `test_size` months = test set)
        X_train, X_test = X[:-test_size], X[-test_size:]
        y_train, y_test = y[:-test_size], y[-test_size:]

        X_train_s = self.scaler.fit_transform(X_train)
        X_test_s = self.scaler.transform(X_test)

        self.model = self._build_model()
        self.model.fit(
            X_train_s,
            y_train,
            eval_set=[(X_test_s, y_test)],
            verbose=False,
        )

        train_preds = self.model.predict(X_train_s)
        test_preds = self.model.predict(X_test_s)

        self.train_mape = mean_absolute_percentage_error(y_train, train_preds)
        self.cv_mape = mean_absolute_percentage_error(y_test, test_preds)

        logger.info(
            f"[{self.category}] Train MAPE={self.train_mape:.3%} | "
            f"Test MAPE={self.cv_mape:.3%}"
        )
        return {"train_mape": self.train_mape, "test_mape": self.cv_mape}

    def predict(self, df: pd.DataFrame) -> np.ndarray:
        X = self.scaler.transform(df[self.feature_cols].values)
        return self.model.predict(X)

    def predict_with_intervals(
        self,
        df: pd.DataFrame,
        alpha: float = 0.1,
    ) -> pd.DataFrame:
        """
        Produce point forecast + prediction intervals using quantile regression.
        alpha=0.1 → 90% interval (5th and 95th percentile).
        """
        point_preds = self.predict(df)

        lower_model = self._build_model(objective="reg:quantileerror")
        lower_model.set_params(quantile_alpha=alpha / 2)
        upper_model = self._build_model(objective="reg:quantileerror")
        upper_model.set_params(quantile_alpha=1 - alpha / 2)

        X = self.scaler.transform(df[self.feature_cols].values)
        y = df["target"].values

        n_train = int(len(X) * 0.8)
        lower_model.fit(X[:n_train], y[:n_train], verbose=False)
        upper_model.fit(X[:n_train], y[:n_train], verbose=False)

        lower_preds = lower_model.predict(X)
        upper_preds = upper_model.predict(X)

        result = df[["period", "year_month", "target"]].copy()
        result["forecast"] = point_preds
        result["forecast_lower"] = lower_preds
        result["forecast_upper"] = upper_preds
        result["residual"] = result["target"] - result["forecast"]
        result["category"] = self.category
        return result

    def get_feature_importance(self) -> pd.DataFrame:
        importances = self.model.feature_importances_
        return (
            pd.DataFrame({"feature": self.feature_cols, "importance": importances})
            .sort_values("importance", ascending=False)
            .reset_index(drop=True)
        )

    def save(self, path: Path | None = None):
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        path = path or MODEL_DIR / f"xgb_{self.category}.pkl"
        with open(path, "wb") as f:
            pickle.dump(self, f)
        logger.info(f"Model saved: {path}")

    @classmethod
    def load(cls, category: str, path: Path | None = None) -> "RetailForecaster":
        path = path or MODEL_DIR / f"xgb_{category}.pkl"
        with open(path, "rb") as f:
            return pickle.load(f)


def run_all_categories(
    feature_matrix_by_category: dict[str, pd.DataFrame],
    test_size: int = 12,
) -> tuple[dict[str, RetailForecaster], pd.DataFrame]:
    """
    Train one model per retail category. Returns models + combined forecast df.
    """
    all_forecasts = []
    models = {}

    for category, df in feature_matrix_by_category.items():
        logger.info(f"Training {category}...")
        model = RetailForecaster(category=category)
        metrics = model.fit(df, test_size=test_size)
        forecast_df = model.predict_with_intervals(df)
        all_forecasts.append(forecast_df)
        models[category] = model
        model.save()

    combined = pd.concat(all_forecasts, ignore_index=True)
    return models, combined


def compute_mape_by_category(forecast_df: pd.DataFrame) -> pd.DataFrame:
    """MAPE per category — used in the dashboard bar chart."""
    rows = []
    for cat, grp in forecast_df.groupby("category"):
        valid = grp.dropna(subset=["target", "forecast"])
        if len(valid) == 0:
            continue
        mape = mean_absolute_percentage_error(valid["target"], valid["forecast"])
        rows.append({"category": cat, "mape": round(mape * 100, 2)})

    return pd.DataFrame(rows).sort_values("mape")
