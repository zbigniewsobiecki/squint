class OrderItem < ApplicationRecord
  belongs_to :order
  belongs_to :book

  validates :quantity, numericality: { greater_than: 0 }
  validates :unit_price_cents, numericality: { greater_than: 0 }

  before_validation :set_unit_price, on: :create

  def subtotal_cents
    quantity * unit_price_cents
  end

  private

  def set_unit_price
    self.unit_price_cents = book&.price_cents if unit_price_cents.blank?
  end
end
