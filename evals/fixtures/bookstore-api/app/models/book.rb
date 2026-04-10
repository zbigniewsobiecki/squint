class Book < ApplicationRecord
  belongs_to :author
  has_many :order_items, dependent: :restrict_with_error
  has_many :orders, through: :order_items

  validates :title, presence: true
  validates :isbn, presence: true, uniqueness: true
  validates :price_cents, numericality: { greater_than: 0 }
  validates :stock_count, numericality: { greater_than_or_equal_to: 0 }

  scope :in_stock, -> { where('stock_count > 0') }
  scope :by_author, ->(author_id) { where(author_id: author_id) }

  after_create :log_new_book

  def price
    price_cents / 100.0
  end

  def in_stock?
    stock_count > 0
  end

  def reserve_stock!(quantity)
    raise InsufficientStockError, "Only #{stock_count} available" if stock_count < quantity

    update!(stock_count: stock_count - quantity)
  end

  private

  def log_new_book
    Rails.logger.info("New book added: #{title} by #{author&.name}")
  end
end

class InsufficientStockError < StandardError; end
