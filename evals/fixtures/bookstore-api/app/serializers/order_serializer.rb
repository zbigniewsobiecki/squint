class OrderSerializer
  attr_reader :order

  def initialize(order)
    @order = order
  end

  def as_json
    {
      id: order.id,
      status: order.status,
      total: format_price(order.total_cents),
      item_count: order.item_count,
      items: serialize_items,
      created_at: order.created_at&.iso8601
    }
  end

  private

  def serialize_items
    order.order_items.includes(:book).map do |item|
      {
        book: BookSerializer.new(item.book).as_json,
        quantity: item.quantity,
        unit_price: format_price(item.unit_price_cents)
      }
    end
  end

  def format_price(cents)
    (cents / 100.0).round(2)
  end
end
